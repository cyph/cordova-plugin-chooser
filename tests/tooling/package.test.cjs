const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const pkg = require("../../package.json");
const root = resolve(__dirname, "../..");

test("npm 12 pack output identifies exactly one named archive", async () => {
	const { packedPackage } = await import("../../scripts/package.mjs");
	const info = { name: pkg.name, filename: `${pkg.name}-${pkg.version}.tgz` };
	assert.deepEqual(
		packedPackage(JSON.stringify({ [pkg.name]: info }), pkg.name),
		info,
	);
	for (const output of [
		[info],
		{ other: info },
		{ [pkg.name]: info, other: info },
		{ [pkg.name]: { ...info, filename: "../package.tgz" } },
	])
		assert.throws(() => packedPackage(JSON.stringify(output), pkg.name));
});

function packageFiles() {
	const sources = readdirSync(resolve(root, "src"), {
		recursive: true,
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile())
		.map((entry) =>
			resolve(entry.parentPath, entry.name).slice(root.length + 1),
		);
	return [
		"package.json",
		"plugin.xml",
		pkg.main,
		pkg.types,
		"LICENSE",
		"NOTICE",
		...sources,
	];
}

test("packing includes nested iOS privacy resources", async () => {
	const { checkPackedFiles } = await import("../../scripts/package.mjs");
	const files = packageFiles();
	checkPackedFiles(root, pkg, files);
	const manifest = "src/ios/ChooserPrivacy.bundle/PrivacyInfo.xcprivacy";
	assert(files.includes(manifest));
	assert.throws(
		() =>
			checkPackedFiles(
				root,
				pkg,
				files.filter((name) => name !== manifest),
			),
		/Missing packed src\/ios\/ChooserPrivacy.bundle\/PrivacyInfo.xcprivacy/,
	);
});

test("packing excludes development tools and fixtures", async () => {
	const { checkPackedFiles } = await import("../../scripts/package.mjs");
	for (const name of [
		"tests/ios/main.swift",
		"scripts/privacy.py",
		".chainman/state.json",
	]) {
		assert.throws(
			() => checkPackedFiles(root, pkg, [...packageFiles(), name]),
			/Unexpected packed/,
		);
	}
});
