const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const commit = "a".repeat(40);
const pkg = {
	name: "cordova-plugin-chooser",
	version: "2.0.0-rc.2",
	main: "www/chooser.js",
	types: "index.d.ts",
	devDependencies: { npm: "12.2.0" },
};

function execute(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout.trim();
}

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "chooser-release-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "committed");
	const files = {
		"package.json": JSON.stringify(pkg),
		"plugin.xml": "<plugin/>",
		"www/chooser.js": "module.exports = {};",
		"src/ios/Chooser.swift": "import Foundation\n",
		"index.d.ts": "export {};",
		LICENSE: "license",
		NOTICE: "notice",
	};
	for (const [name, bytes] of Object.entries(files)) {
		mkdirSync(dirname(join(source, name)), { recursive: true });
		writeFileSync(join(source, name), bytes);
	}
	const pack = (directory, destination) => {
		const filename = `${pkg.name}-${pkg.version}.tgz`;
		const archive = join(destination, filename);
		execute("python3", [
			"-c",
			`import sys,tarfile
with tarfile.open(sys.argv[2], 'w:gz') as t: t.add(sys.argv[1], arcname='package')`,
			directory,
			archive,
		]);
		return {
			archive,
			info: {
				name: pkg.name,
				filename,
				integrity: integrity(archive),
				files: Object.keys(files).map((path) => ({ path })),
			},
		};
	};
	return { root, source, files, pack };
}

const integrity = (archive) =>
	`sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;

test("release manifest checks the actual archive identity and qualified digest", async (t) => {
	const { releaseManifest } = await import("../../scripts/release.mjs");
	const f = fixture(t);
	const { archive, info } = f.pack(f.source, f.root);
	const options = { archive, commit, integrity: info.integrity, pkg };
	const manifest = releaseManifest(options);
	assert.equal(manifest.sourceCommit, commit);
	assert.equal(
		manifest.artifacts[0].subject,
		`pkg:npm/${pkg.name}@${pkg.version}`,
	);
	assert.equal(manifest.artifacts[0].path, info.filename);
	assert.equal(
		manifest.artifacts[0].digest.sha512,
		createHash("sha512").update(readFileSync(archive)).digest("hex"),
	);
	for (const patch of [{ name: "substitute" }, { version: "9.0.0" }])
		assert.throws(
			() => releaseManifest({ ...options, pkg: { ...pkg, ...patch } }),
			/name\/version mismatch/,
		);
	appendFileSync(archive, "tampered");
	assert.throws(() => releaseManifest(options), /integrity mismatch/);
});

test("CI release preparation consumes the retained portable archive without repacking", async (t) => {
	const { prepareCiRelease } = await import("../../scripts/release.mjs");
	const f = fixture(t);
	writeFileSync(join(f.root, "package.json"), JSON.stringify(pkg));
	const retained = join(f.root, ".verification/release-input/portable");
	mkdirSync(retained, { recursive: true });
	const { archive, info } = f.pack(f.source, retained);
	assert.throws(
		() =>
			prepareCiRelease({ root: f.root, commit, integrity: "sha512-YWJjZA==" }),
		/integrity mismatch/,
	);
	const path = prepareCiRelease({
		root: f.root,
		commit,
		integrity: info.integrity,
	});
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(
		readFileSync(join(dirname(path), manifest.artifacts[0].path)),
		readFileSync(archive),
	);
});

function publicationFixture(t, fault) {
	const f = fixture(t);
	const calls = [];
	const run = (command, args, cwd) => {
		calls.push({ command, args, cwd });
		if (command === "git") {
			if (args[0] === "status") return fault === "dirty" ? " M plugin.xml" : "";
			if (args[0] === "rev-parse") return commit;
			assert.equal(args[0], "archive");
			assert.equal(args.at(-1), commit);
			return "";
		}
		if (command === "python3" && args[0] === "-m") {
			cpSync(f.source, args[4], { recursive: true });
			return "";
		}
		if (command === "pinned-node") {
			assert.equal(args[0], "pinned-npm-cli.js");
			assert.deepEqual(args.slice(1, 5), [
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
			]);
			assert.notEqual(cwd, f.root);
			if (fault === "identity")
				writeFileSync(
					join(cwd, "package.json"),
					JSON.stringify({ ...pkg, name: "substitute" }),
				);
			const { archive, info } = f.pack(cwd, args[5]);
			if (fault === "tamper") appendFileSync(archive, "tampered");
			return JSON.stringify({ [pkg.name]: info });
		}
		if (command === "just") {
			assert.deepEqual(
				[args[0], args[1], ...args.slice(3)],
				["chainman", "npm-publish", "--run", "123"],
			);
			assert(!args[2].startsWith("/"));
			const manifest = JSON.parse(readFileSync(join(f.root, args[2]), "utf8"));
			assert.equal(manifest.sourceCommit, commit);
			const archive = join(
				dirname(join(f.root, args[2])),
				manifest.artifacts[0].path,
			);
			assert.equal(
				createHash("sha512").update(readFileSync(archive)).digest("hex"),
				manifest.artifacts[0].digest.sha512,
			);
			if (fault === "CI-mismatch")
				throw new Error("Qualified CI subject/digest mismatch");
			return "verified frozen archive";
		}
		return execute(command, args, cwd);
	};
	return {
		...f,
		calls,
		run,
		npm: () => ({ command: "pinned-node", args: ["pinned-npm-cli.js"] }),
	};
}

test("manual publication snapshots committed source and passes only its frozen archive to the verifier/publisher", async (t) => {
	const { publishRelease } = await import("../../scripts/release.mjs");
	const f = publicationFixture(t);
	const manifest = publishRelease({ ...f, runId: "123" });
	assert.equal(
		f.calls.filter(({ command }) => command === "pinned-node").length,
		1,
	);
	assert.equal(f.calls.filter(({ command }) => command === "just").length, 1);
	assert.equal(JSON.parse(readFileSync(manifest, "utf8")).sourceCommit, commit);
});

for (const [fault, expected] of [
	["dirty", /clean checkout/],
	["tamper", /integrity mismatch/],
	["identity", /name\/version mismatch/],
	["CI-mismatch", /Qualified CI subject\/digest mismatch/],
]) {
	test(`manual publication fails closed for ${fault}`, async (t) => {
		const { publishRelease } = await import("../../scripts/release.mjs");
		const f = publicationFixture(t, fault);
		assert.throws(() => publishRelease({ ...f, runId: "123" }), expected);
		assert.equal(
			f.calls.filter(({ command }) => command === "just").length,
			fault === "CI-mismatch" ? 1 : 0,
		);
	});
}

test("npm is resolved lazily from the project and checked against its exact pin", async (t) => {
	const { pinnedNpm } = await import("../../scripts/npm.mjs");
	const f = fixture(t);
	writeFileSync(join(f.root, "package.json"), JSON.stringify(pkg));
	const installed = join(f.root, "node_modules/npm");
	mkdirSync(installed, { recursive: true });
	writeFileSync(
		join(installed, "package.json"),
		JSON.stringify({ name: "npm", version: "12.2.0" }),
	);
	assert.deepEqual(pinnedNpm(f.root), {
		command: process.execPath,
		args: [join(installed, "bin/npm-cli.js")],
	});
	writeFileSync(
		join(installed, "package.json"),
		JSON.stringify({ name: "npm", version: "12.1.0" }),
	);
	assert.throws(() => pinnedNpm(f.root), /differs from the package pin/);
});
