const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const {
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	realpathSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

test("Cordova resolves frozen platform packages without npm installation", async (t) => {
	const { stageFrozenPackage } =
		await import("../../scripts/fixture-packages.mjs");
	const fetch = createRequire(require.resolve("cordova/package.json"))(
		"cordova-fetch",
	);
	const root = resolve(__dirname, "../..");
	const directory = mkdtempSync(join(tmpdir(), "chooser-frozen-platforms-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const tools = join(directory, "tools");
	mkdirSync(tools);
	writeFileSync(join(tools, "npm"), "#!/bin/sh\nexit 98\n", { mode: 0o700 });
	const originalPath = process.env.PATH;
	process.env.PATH = `${tools}:${originalPath}`;
	try {
		for (const alias of [
			"cordova-android14",
			"cordova-android15",
			"cordova-ios7",
			"cordova-ios8",
			"cordova-browser",
		]) {
			const source = join(root, "node_modules", alias);
			const application = join(directory, alias);
			const { name, version } = stageFrozenPackage(application, source);
			assert.equal(
				realpathSync(await fetch(`${name}@${version}`, application)),
				realpathSync(source),
			);
			const appRequire = createRequire(join(application, "package.json"));
			const sourceRequire = createRequire(join(source, "package.json"));
			for (const dependency of Object.keys(
				require(`${alias}/package.json`).dependencies || {},
			)) {
				assert.equal(
					realpathSync(appRequire.resolve(dependency)),
					realpathSync(sourceRequire.resolve(dependency)),
				);
			}
		}
		assert.throws(
			() =>
				stageFrozenPackage(
					join(directory, "cordova-android14"),
					join(root, "node_modules", "cordova-android15"),
				),
			/Unexpected fixture package/,
		);
	} finally {
		process.env.PATH = originalPath;
	}
});

test("Apple subprocesses use the pinned Xcode despite Nix SDK defaults", async () => {
	const { appleEnvironment } = await import("../../scripts/apple.mjs");
	const apple = require("../../chainman/apple.json");
	const inherited = {
		DEVELOPER_DIR: "/nix/store/fixture-apple-sdk/Library/Developer",
		SDKROOT: "/nix/store/fixture-apple-sdk/MacOSX.sdk",
		CC: "/nix/store/fixture-clang/bin/clang",
		CXX: "/nix/store/fixture-clang/bin/clang++",
		LD: "/nix/store/fixture-linker/bin/ld",
		SWIFT_EXEC: "/nix/store/fixture-swift/bin/swiftc",
		PATH: "/nix/store/fixture-node/bin:/nix/store/fixture-pnpm/bin",
	};
	const original = { ...inherited };
	const child = spawnSync(
		process.execPath,
		["-e", "process.stdout.write(JSON.stringify(process.env))"],
		{
			encoding: "utf8",
			env: { ...inherited, ...appleEnvironment(apple, inherited) },
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const actual = JSON.parse(child.stdout);
	assert.equal(actual.DEVELOPER_DIR, apple.developerDirectory);
	assert(
		!("SDKROOT" in actual),
		"The host macOS SDK must not override iPhoneOS lookup",
	);
	for (const tool of ["CC", "CXX", "LD", "SWIFT_EXEC"])
		assert(!(tool in actual), `Xcode must select its own ${tool}`);
	const paths = actual.PATH.split(":");
	assert.equal(paths[0], `${apple.developerDirectory}/usr/bin`);
	assert(paths.includes("/nix/store/fixture-node/bin"));
	assert(paths.includes("/nix/store/fixture-pnpm/bin"));
	assert(paths.includes("/usr/bin"));
	assert(!paths.includes(""));
	assert.deepEqual(inherited, original);

	const explicit = "/Applications/Selected-Xcode.app/Contents/Developer";
	assert.equal(
		appleEnvironment(apple, { DEVELOPER_DIR: explicit }).DEVELOPER_DIR,
		explicit,
		"Explicit host selections must reach the version/SDK validation",
	);
});

test("frozen platform aliases retain each compatibility generation", () => {
	for (const [alias, name, major] of [
		["cordova-android14", "cordova-android", 14],
		["cordova-android15", "cordova-android", 15],
		["cordova-ios7", "cordova-ios", 7],
		["cordova-ios8", "cordova-ios", 8],
	]) {
		const pkg = require(`${alias}/package.json`);
		assert.equal(pkg.name, name);
		assert.equal(Number(pkg.version.split(".")[0]), major);
	}
});

test("both iOS project generators retain the CommonJS UUID contract", () => {
	for (const alias of ["cordova-ios7", "cordova-ios8"]) {
		const platformRequire = createRequire(
			require.resolve(`${alias}/package.json`),
		);
		const project = platformRequire("xcode").project(
			"fixture.xcodeproj/project.pbxproj",
		);
		project.hash = { project: { objects: {} } };
		const identifiers = new Set();
		for (let i = 0; i < 100; i++) {
			const id = project.generateUuid();
			assert.match(id, /^[A-F0-9]{24}$/);
			assert(!identifiers.has(id), "Duplicate Xcode project identifier");
			identifiers.add(id);
		}
	}
});
