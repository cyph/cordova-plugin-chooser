const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");

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
