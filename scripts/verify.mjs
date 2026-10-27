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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	aggregateReports,
	requiredChecks,
	simulatorPartitionChecks,
} from "./qualification.mjs";
import { appleEnvironment, prepareBridgingHeader } from "./apple.mjs";
import { stageFrozenPackage } from "./fixture-packages.mjs";
import { checkPackedFiles } from "./package.mjs";
import { verifyIosSimulator } from "./ios-simulator.mjs";
import {
	simulatorOptions,
	simulatorDocuments,
	simulatorPartitionOptions,
} from "./simulator-results.mjs";
import { spawnVerified } from "./verification-command.mjs";
import { verifyCapacitorAndroid, prepareCapacitor } from "./capacitor.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".verification");
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJSON(join(root, "package.json"));
const commandLane = process.argv[2];
const partition =
	commandLane === "ios-simulator-part"
		? simulatorPartitionOptions(process.argv.slice(3))
		: undefined;
const lane = partition ? "ios-simulator" : commandLane;
const reportDirectory = join(
	output,
	"reports",
	partition
		? `${lane}-${partition.framework}-${partition.device}`
		: lane || "unknown",
);
const report = {
	schema: 1,
	lane,
	commit: spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).stdout?.trim(),
	status: "running",
	platform: `${process.platform}/${process.arch}`,
	toolchain: { node: process.versions.node },
	checks: [],
	commands: [],
};
const checked = (name) => {
	report.checks.push(name);
};
function saveReport() {
	mkdirSync(reportDirectory, { recursive: true });
	writeFileSync(
		join(reportDirectory, "qualification.json"),
		JSON.stringify(report, null, 2) + "\n",
	);
}
function retain(source, name) {
	assert(existsSync(source), `Missing qualification output: ${source}`);
	cpSync(source, join(reportDirectory, name), { recursive: true });
}
const run = (
	command,
	args,
	cwd = root,
	capture = false,
	env = {},
	{ timeout = 20 * 60 * 1000 } = {},
) => {
	console.log(`> ${command} ${args.join(" ")}`);
	const result = spawnVerified(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: "pipe",
		encoding: "utf8",
		timeout,
		maxBuffer: 64 * 1024 * 1024,
	});
	mkdirSync(reportDirectory, { recursive: true });
	const log = `command-${String(report.commands.length + 1).padStart(3, "0")}.log`;
	writeFileSync(
		join(reportDirectory, log),
		`${result.stdout || ""}${result.stderr || ""}`,
	);
	report.commands.push({ command, args, status: result.status, log });
	if (!capture) {
		process.stdout.write(result.stdout || "");
		process.stderr.write(result.stderr || "");
	}
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
		{ npm_config_ignore_scripts: "true", npm_config_offline: "true", ...env },
	);

function installPlugin(destination, archive, env = {}) {
	const { name, version } = stageFrozenPackage(destination, archive);
	cordova(
		["plugin", "add", `${name}@${version}`, "--nosave"],
		destination,
		env,
	);
}

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
	report.package = { version: pkg.version, integrity: info.integrity };
	checked("package");
	const files = new Set(info.files.map((file) => file.path));
	checkPackedFiles(root, pkg, files);
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
	run("python3", [
		join(root, "scripts/check-package.py"),
		join(extracted, "package"),
	]);
	return join(extracted, "package");
}

function app(platform, alias, archive, env = {}, beforePlugin = () => {}) {
	const destination = join(output, platform === "ios" ? lane : "", alias);
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(dirname(destination), { recursive: true });
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
	const { version } = stageFrozenPackage(
		destination,
		join(root, "node_modules", alias),
	);
	cordova(
		["platform", "add", `${platform}@${version}`, "--nosave"],
		destination,
		env,
	);
	beforePlugin(destination);
	installPlugin(destination, archive, env);
	cordova(["prepare", platform], destination, env);
	return destination;
}

function portable() {
	staticChecks();
	run("pnpm", ["test"]);
	checked("contracts");
	run("pnpm", ["test:types"]);
	checked("types");
	run("node", [
		"--test",
		"tests/tooling/platforms.test.cjs",
		"tests/tooling/verification.test.cjs",
		"tests/tooling/package.test.cjs",
		"tests/tooling/qualification.test.cjs",
		"tests/tooling/verification-lifecycle.test.cjs",
		"tests/tooling/verification-command.test.cjs",
		"tests/tooling/simulator-policy.test.cjs",
	]);
	checked("tooling");
	run("python3", [
		"-m",
		"unittest",
		"discover",
		"-s",
		"tests/tooling",
		"-p",
		"*_test.py",
	]);
	checked("privacy");
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
	checked("browsers");
	cordova(["plugin", "remove", pkg.name, "--nosave"], destination);
	stageFrozenPackage(
		destination,
		join(root, "node_modules", "cordova-browser"),
	);
	installPlugin(destination, packed);
	cordova(["prepare", "browser"], destination);
	checked("reinstall");
}

const androidFixtures = [
	["android", "cordova-android14", "35.0.0"],
	["android15", "cordova-android15", "36.0.0"],
];

function androidEnvironment(execute = false) {
	if (execute && process.platform === "linux" && process.arch !== "x64")
		throw new Error(
			"Android build tools require Linux x86_64; use the CI Android lane.",
		);
	assert(
		process.env.ANDROID_HOME && existsSync(process.env.ANDROID_HOME),
		"Missing Nix Android SDK",
	);
	report.toolchain.androidRuntimeApis = [24, 28, 30, 33, 35];
	report.toolchain.gradle = run("gradle", ["--version"], root, true);
	assert.match(report.toolchain.gradle, /Gradle 8\./);
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
	androidEnvironment(true);
	const archive = pack();
	for (const [fixture, alias, buildTools] of androidFixtures) {
		// Continue independent checks so one failure still yields the other
		// SDK and lint diagnostics in the same qualification attempt.
		run("gradle", [
			...androidArguments(fixture, buildTools, "testApi24"),
			"testApi28",
			"testApi30",
			"testApi33",
			"testApi35",
			"lintDebug",
			"lintRelease",
			"--continue",
		]);
		for (const api of [24, 28, 30, 33, 35]) {
			run("python3", [
				join(root, "scripts/android_reports.py"),
				"tests",
				join(root, "tests", fixture, "build/test-results", `testApi${api}`),
			]);
			checked(`${fixture}:api${api}`);
		}
		run("python3", [
			join(root, "scripts/android_reports.py"),
			"lint",
			join(root, "tests", fixture, "build/reports"),
		]);
		checked(`${fixture}:lint`);
		const destination = app("android", alias, archive);
		for (const configuration of ["debug", "release"]) {
			cordova(
				[
					"build",
					"android",
					`--${configuration}`,
					"--",
					"--packageType=apk",
					`--gradleArg=-Pandroid.aapt2FromMavenOverride=${aapt2Path(buildTools)}`,
				],
				destination,
			);
			if (configuration === "release") {
				const directory = join(
					destination,
					"platforms/android/app/build/outputs/apk/release",
				);
				const apks = readdirSync(directory).filter((name) =>
					name.endsWith(".apk"),
				);
				assert.equal(apks.length, 1, "Expected one release APK");
				const resources = join(
					reportDirectory,
					`${fixture}-release-resources.txt`,
				);
				writeFileSync(
					resources,
					run(
						aapt2Path(buildTools),
						["dump", "resources", join(directory, apks[0])],
						root,
						true,
					),
				);
				run("python3", [
					join(root, "scripts/android_reports.py"),
					"apk",
					directory,
					"--resources",
					resources,
				]);
			}
			checked(`${fixture}:${configuration}`);
		}
		cordova(["plugin", "remove", pkg.name, "--nosave"], destination);
		stageFrozenPackage(destination, join(root, "node_modules", alias));
		installPlugin(destination, archive);
		cordova(["prepare", "android"], destination);
		checked(`${fixture}:reinstall`);
	}
}

function ios(modern = false) {
	assert.equal(process.platform, "darwin", "iOS verification requires macOS");
	run("node", ["--test", "tests/tooling/verification-command.test.cjs"]);
	const apple = readJSON(
		join(root, modern ? "chainman/apple-modern.json" : "chainman/apple.json"),
	);
	report.toolchain.apple = apple;
	const env = appleEnvironment(apple);
	report.toolchain.swift = run(
		"/usr/bin/xcrun",
		["swiftc", "--version"],
		root,
		true,
		env,
	);
	assert.equal(
		run("/usr/bin/xcodebuild", ["-version"], root, true, env),
		`Xcode ${apple.xcode}\nBuild version ${apple.build}`,
	);
	assert.equal(
		run(
			"/usr/bin/xcrun",
			["--sdk", "iphoneos", "--show-sdk-version"],
			root,
			true,
			env,
		),
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
		"/usr/bin/xcrun",
		[
			"swiftc",
			"-swift-version",
			"5",
			"-strict-concurrency=complete",
			"-warn-concurrency",
			"-warnings-as-errors",
			"-whole-module-optimization",
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
	checked("foundation");
	if (modern)
		for (const sanitizer of ["address", "thread"]) {
			const binary = join(output, `foundation-${sanitizer}`);
			run(
				"/usr/bin/xcrun",
				[
					"swiftc",
					"-swift-version",
					"5",
					"-sanitize=" + sanitizer,
					"-g",
					"-Onone",
					...sources,
					"tests/ios/main.swift",
					"-o",
					binary,
				],
				root,
				false,
				env,
			);
			run(binary, [], root, false, {
				...env,
				ASAN_OPTIONS: "halt_on_error=1",
				TSAN_OPTIONS: "halt_on_error=1",
			});
			checked(`${sanitizer}-sanitizer`);
		}
	const archive = pack();
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const projectName = alias === "cordova-ios7" ? "ChooserFixture" : "App";
		const privacy = (operation, destination) =>
			run("python3", [
				join(root, "scripts/privacy.py"),
				operation,
				join(
					destination,
					"platforms/ios",
					operation === "archive" ? "" : projectName,
				),
				join(destination, "privacy-snapshot.json"),
			]);
		const destination = app("ios", alias, archive, env, (destination) => {
			const config = join(destination, "config.xml");
			const contents = readFileSync(config, "utf8");
			assert(contents.includes("</widget>"), "Missing application widget");
			writeFileSync(
				config,
				contents.replace(
					"</widget>",
					`${readFileSync(join(root, "tests/ios/privacy-app.xml"), "utf8")}</widget>`,
				),
			);
			installPlugin(destination, join(root, "tests/ios/privacy-plugin"), env);
			cordova(["prepare", "ios"], destination, env);
			privacy("snapshot", destination);
		});
		privacy("installed", destination);
		cordova(["prepare", "ios"], destination, env);
		privacy("installed", destination);
		// Both platform generations accept buildFlag through buildConfig; iOS 7
		// does not parse the CLI's forwarded platform-specific arguments.
		const buildConfig = join(destination, "build.json");
		writeFileSync(
			buildConfig,
			JSON.stringify({
				ios: Object.fromEntries(
					["debug", "release"].map((configuration) => [
						configuration,
						{
							buildFlag: [
								"CODE_SIGNING_ALLOWED=NO",
								"IPHONEOS_DEPLOYMENT_TARGET=15.0",
								"SWIFT_STRICT_CONCURRENCY=complete",
								"SWIFT_SUPPRESS_WARNINGS=NO",
								"SWIFT_TREAT_WARNINGS_AS_ERRORS=YES",
							],
						},
					]),
				),
			}),
		);
		const build = (configuration = "debug") => {
			if (alias === "cordova-ios7")
				prepareBridgingHeader(
					join(destination, "platforms/ios", projectName, "Bridging-Header.h"),
				);
			// Require a fresh archive after reinstallation, never an earlier output.
			rmSync(join(destination, "platforms/ios", `${projectName}.xcarchive`), {
				recursive: true,
				force: true,
			});
			cordova(
				[
					"build",
					"ios",
					`--${configuration}`,
					"--device",
					"--noSign",
					`--buildConfig=${buildConfig}`,
				],
				destination,
				env,
			);
			privacy("archive", destination);
		};
		build();
		checked(`${alias}:debug`);
		cordova(["plugin", "remove", pkg.name, "--nosave"], destination, env);
		privacy("removed", destination);
		stageFrozenPackage(destination, join(root, "node_modules", alias));
		cordova(["prepare", "ios"], destination, env);
		privacy("removed", destination);
		installPlugin(destination, archive, env);
		cordova(["prepare", "ios"], destination, env);
		privacy("installed", destination);
		build();
		checked(`${alias}:reinstall`);
		build("release");
		checked(`${alias}:release`);
	}
}

const diagnosticLane = "ios-simulator-diagnostic";
const simulatorConfiguration = [diagnosticLane, "ios-simulator"].includes(lane)
	? simulatorOptions(
			partition ? [] : process.argv.slice(3),
			lane === diagnosticLane,
		)
	: undefined;
const diagnosticDevice = simulatorConfiguration?.device;
const expectedChecks =
	lane === diagnosticLane
		? [
				"package",
				"cordova-ios7:compile",
				"cordova-ios8:compile",
				...(["all", "provider"].includes(simulatorConfiguration.scope)
					? [`cordova-ios7:${diagnosticDevice}:provider-setup`]
					: []),
				...(simulatorConfiguration.scope === "all"
					? simulatorDocuments.map(
							({ format }) =>
								`cordova-ios7:${diagnosticDevice}:seed-${format.toLowerCase()}`,
						)
					: []),
				...(simulatorConfiguration.scope === "provider"
					? [
							`cordova-ios7:${diagnosticDevice}:export-json`,
							`cordova-ios7:${diagnosticDevice}:export-pdf`,
						]
					: []),
				`cordova-ios7:${diagnosticDevice}:native-control`,
				`cordova-ios7:${diagnosticDevice}`,
			]
		: partition
			? simulatorPartitionChecks(partition)
			: requiredChecks[lane];
function simulator(diagnostic = false) {
	assert.equal(process.platform, "darwin", "iOS verification requires macOS");
	run("node", ["--test", "tests/tooling/verification-command.test.cjs"]);
	return verifyIosSimulator({
		root,
		output,
		reportDirectory,
		report,
		run,
		pack,
		app,
		checked,
		diagnostic,
		partition,
		diagnosticDevice,
		diagnosticScope: simulatorConfiguration.scope,
		modern: simulatorConfiguration.profile === "modern",
	});
}

const lanes = {
	portable,
	browser,
	android,
	"android-dependencies": androidDependencies,
	ios,
	"ios-modern": () => ios(true),
	"ios-simulator": () => simulator(),
	"ios-simulator-part": () => simulator(),
	"ios-simulator-diagnostic": () => simulator(true),
	"capacitor-android": () =>
		verifyCapacitorAndroid({
			root,
			output,
			reportDirectory,
			report,
			run,
			pack,
			checked,
			aapt2Path,
		}),
	"capacitor-prepare": () => prepareCapacitor({ root, output, run, pack }),
	"android-failures"() {
		androidEnvironment(true);
		pack();
		run("python3", [join(root, "scripts/android-failures.py")]);
		checked("dependency-failures");
	},
	qualification() {
		console.log(
			JSON.stringify(
				aggregateReports(
					process.env.CHOOSER_REPORTS_ROOT || join(output, "downloaded"),
					process.env.GITHUB_SHA || report.commit,
					JSON.parse(process.env.CHOOSER_JOB_RESULTS || "{}"),
				),
				null,
				2,
			),
		);
	},
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
try {
	if (expectedChecks) {
		rmSync(reportDirectory, { recursive: true, force: true });
		saveReport();
	}
	await lanes[commandLane]();
	if (expectedChecks) {
		for (const check of expectedChecks)
			assert(
				report.checks.includes(check),
				`Missing qualification check: ${check}`,
			);
		report.status = "passed";
		saveReport();
	}
} catch (error) {
	if (expectedChecks) {
		report.status = "failed";
		report.failure = error.message;
		const describe = (error) => ({
			name: error.name,
			message: error.message,
			...(error.cause ? { cause: describe(error.cause) } : {}),
			...(error.errors ? { errors: error.errors.map(describe) } : {}),
		});
		report.failureDetails = describe(error);
		saveReport();
	}
	throw error;
} finally {
	if (lane === "android")
		for (const [fixture] of androidFixtures) {
			for (const directory of ["reports", "test-results"]) {
				const source = join(root, "tests", fixture, "build", directory);
				if (existsSync(source)) retain(source, `${fixture}-${directory}`);
			}
		}
}
