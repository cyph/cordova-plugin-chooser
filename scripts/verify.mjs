import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".verification");
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJSON(join(root, "package.json"));
const run = (command, args, cwd = root, capture = false, env = {}) => {
	console.log(`> ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: capture ? "pipe" : "inherit",
		encoding: "utf8",
		timeout: 20 * 60 * 1000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (capture) process.stderr.write(`${result.stdout}${result.stderr}`);
		throw new Error(`${command} failed (${result.status ?? result.signal})`);
	}
	return result.stdout?.trim();
};
const cordova = (args, cwd = root, env = {}) =>
	run(
		"node",
		[join(root, "node_modules/cordova/bin/cordova"), ...args],
		cwd,
		false,
		env,
	);

function staticChecks() {
	assert.equal(
		`${process.versions.node.split(".")[0]}.x`,
		readJSON(join(root, "chainman/node.json")).version,
		"Node must match the Nix-owned pin",
	);
	assert.equal(
		`pnpm@${run("pnpm", ["--version"], root, true)}`,
		pkg.packageManager,
	);
	run("python3", [join(root, "scripts/check-package.py")]);
	for (const directory of ["www", "src/browser", "tests/js"]) {
		for (const name of readdirSync(join(root, directory)).filter((name) =>
			name.endsWith(".js"),
		)) {
			run("node", ["--check", join(directory, name)]);
		}
	}
	// Git's whitespace check can refresh index bytes, even with optional locks off.
	const index = run(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		root,
		true,
	);
	const temporary = mkdtempSync(join(tmpdir(), "chooser-index-"));
	try {
		const copy = join(temporary, "index");
		cpSync(index, copy);
		for (const args of [["--check"], ["--cached", "--check"]])
			run("git", ["diff", ...args], root, false, { GIT_INDEX_FILE: copy });
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function pack() {
	const directory = join(output, "package");
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const [info] = JSON.parse(
		run(
			"npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
			root,
			true,
		),
	);
	const files = new Set(info.files.map((file) => file.path));
	for (const name of [
		"package.json",
		"plugin.xml",
		pkg.main,
		pkg.types,
		"LICENSE",
		"NOTICE",
	])
		assert(files.has(name), `Missing packed ${name}`);
	for (const directory of ["src/android", "src/ios", "src/browser"]) {
		for (const name of readdirSync(join(root, directory)))
			assert(files.has(`${directory}/${name}`), `Missing packed ${name}`);
	}
	for (const name of files)
		assert(
			!/^(tests|scripts|node_modules|\.verification|\.chainman|\.github)\//.test(
				name,
			),
			`Unexpected packed ${name}`,
		);
	const archive = join(directory, info.filename);
	console.log(
		`Package: ${info.filename}, ${files.size} files, integrity ${info.integrity}`,
	);
	// Cordova's plugin engine inspection expects a directory, not an npm tarball.
	const extracted = join(directory, "unpacked");
	mkdirSync(extracted);
	run("python3", [
		"-m",
		"tarfile",
		"--extract",
		archive,
		extracted,
		"--filter",
		"data",
	]);
	return join(extracted, "package");
}

function app(platform, alias, archive, env = {}) {
	const destination = join(output, alias);
	rmSync(destination, { recursive: true, force: true });
	cordova(
		[
			"create",
			destination,
			`com.cyph.chooser.${alias.replaceAll("-", "")}`,
			"ChooserFixture",
		],
		root,
		env,
	);
	// The platform comes from the frozen dependency graph, never a registry range.
	cordova(
		["platform", "add", join(root, "node_modules", alias), "--nosave"],
		destination,
		env,
	);
	cordova(["plugin", "add", archive, "--nosave"], destination, env);
	cordova(["prepare", platform], destination, env);
	return destination;
}

function portable() {
	staticChecks();
	run("pnpm", ["test"]);
	run("pnpm", ["test:types"]);
	run("node", [
		"--test",
		"tests/tooling/platforms.test.cjs",
		"tests/tooling/verification.test.cjs",
	]);
	pack();
}

function browser() {
	const packed = pack();
	const destination = app("browser", "cordova-browser", packed);
	cpSync(join(root, "tests/browser/www"), join(destination, "www"), {
		recursive: true,
	});
	cordova(["prepare", "browser"], destination);
	run(
		"node",
		["--test", "--test-force-exit", "tests/browser/integration.test.cjs"],
		root,
		false,
		{
			CHOOSER_BROWSER_ROOT: join(destination, "platforms/browser/www"),
		},
	);
	cordova(["plugin", "remove", pkg.name, "--nosave"], destination);
	cordova(["plugin", "add", packed, "--nosave"], destination);
	cordova(["prepare", "browser"], destination);
}

const androidFixtures = [
	["android", "cordova-android14", "35.0.0"],
	["android15", "cordova-android15", "36.0.0"],
];

function androidEnvironment() {
	assert(
		process.env.ANDROID_HOME && existsSync(process.env.ANDROID_HOME),
		"Missing Nix Android SDK",
	);
	assert.match(run("gradle", ["--version"], root, true), /Gradle 8\./);
}

function aapt2Path(buildTools) {
	const path = join(
		process.env.ANDROID_HOME,
		"build-tools",
		buildTools,
		"aapt2",
	);
	assert(statSync(path).isFile(), "Missing Nix-owned AAPT2 executable");
	accessSync(path, constants.R_OK | constants.X_OK);
	return path;
}

function androidArguments(fixture, buildTools, task) {
	assert(
		existsSync(join(root, "tests", fixture, "gradle.lockfile")),
		"Resolve and review the Gradle lock first through chainman.",
	);
	assert(
		existsSync(
			join(root, "tests", fixture, "gradle/verification-metadata.xml"),
		),
		"Missing Gradle checksum metadata.",
	);
	return [
		"--no-daemon",
		"--dependency-verification",
		"strict",
		"-p",
		`tests/${fixture}`,
		`-Pandroid.aapt2FromMavenOverride=${aapt2Path(buildTools)}`,
		task,
	];
}

function androidDependencies() {
	androidEnvironment();
	for (const [fixture, , buildTools] of androidFixtures)
		run(
			"gradle",
			androidArguments(fixture, buildTools, "prepareRobolectricSdks"),
		);
}

function android() {
	if (process.platform === "linux" && process.arch !== "x64")
		throw new Error(
			"Android build tools require Linux x86_64; use the CI Android lane.",
		);
	androidEnvironment();
	const archive = pack();
	for (const [fixture, alias, buildTools] of androidFixtures) {
		run("gradle", androidArguments(fixture, buildTools, "testDebugUnitTest"));
		const destination = app("android", alias, archive);
		cordova(
			[
				"build",
				"android",
				"--debug",
				"--",
				`--gradleArg=-Pandroid.aapt2FromMavenOverride=${aapt2Path(buildTools)}`,
			],
			destination,
		);
		cordova(["plugin", "remove", pkg.name, "--nosave"], destination);
		cordova(["plugin", "add", archive, "--nosave"], destination);
		cordova(["prepare", "android"], destination);
	}
}

function ios() {
	assert.equal(process.platform, "darwin", "iOS verification requires macOS");
	const apple = readJSON(join(root, "chainman/apple.json"));
	const env = {
		DEVELOPER_DIR: process.env.DEVELOPER_DIR || apple.developerDirectory,
	};
	assert.equal(
		run("xcodebuild", ["-version"], root, true, env),
		`Xcode ${apple.xcode}\nBuild version ${apple.build}`,
	);
	assert.equal(
		run("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"], root, true, env),
		apple.iphoneos,
	);
	mkdirSync(output, { recursive: true });
	const sources = [
		"ChooserError",
		"ChooserBudget",
		"ChooserWork",
		"ChooserRequest",
		"ChooserFiles",
		"ChooserTransaction",
	].map((name) => `src/ios/${name}.swift`);
	run(
		"xcrun",
		[
			"swiftc",
			"-swift-version",
			"5",
			...sources,
			"tests/ios/main.swift",
			"-o",
			join(output, "foundation"),
		],
		root,
		false,
		env,
	);
	run(join(output, "foundation"), [], root, false, env);
	const archive = pack();
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const destination = app("ios", alias, archive, env);
		cordova(
			[
				"build",
				"ios",
				"--debug",
				"--device",
				"--",
				"--buildFlag=CODE_SIGNING_ALLOWED=NO",
			],
			destination,
			env,
		);
		cordova(["plugin", "remove", pkg.name, "--nosave"], destination, env);
		cordova(["plugin", "add", archive, "--nosave"], destination, env);
		cordova(["prepare", "ios"], destination, env);
	}
}

const lanes = {
	portable,
	browser,
	android,
	"android-dependencies": androidDependencies,
	ios,
	doctor() {
		staticChecks();
		console.log(
			`Host: ${process.platform}/${process.arch}. Apple SDK is an external macOS prerequisite; Android Linux builds require x86_64.`,
		);
	},
	clean() {
		rmSync(output, { recursive: true, force: true });
		for (const fixture of ["android", "android15"])
			for (const name of ["build", ".gradle"])
				rmSync(join(root, "tests", fixture, name), {
					recursive: true,
					force: true,
				});
	},
};
assert(
	Object.hasOwn(lanes, process.argv[2]),
	"Select a declared verification lane.",
);
lanes[process.argv[2]]();
