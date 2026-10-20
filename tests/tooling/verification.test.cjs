const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
	appendFileSync,
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "chooser-verification-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "checkout");
	const source = resolve(__dirname, "../..");
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	Object.assign(env, {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	});
	const clone = spawnSync(
		"git",
		["clone", "--quiet", "--no-hardlinks", source, root],
		{
			env,
			encoding: "utf8",
		},
	);
	assert.equal(clone.status, 0, clone.stderr);
	// Include the verifier and package resources under test, including new files.
	for (const name of ["scripts", "src", "plugin.xml", "package.json"])
		cpSync(join(source, name), join(root, name), { recursive: true });
	const readme = join(root, "README.md");
	const index = join(root, ".git/index");
	const verify = () =>
		spawnSync(process.execPath, ["scripts/verify.mjs", "doctor"], {
			cwd: root,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
	return { root, readme, index, env, verify };
}

test("verification preserves index bytes when tracked file timestamps change", (t) => {
	const f = fixture(t);
	utimesSync(f.readme, new Date(1_000), new Date(1_000));
	const before = readFileSync(f.index);
	const result = f.verify();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(readFileSync(f.index), before);
});

for (const staged of [false, true]) {
	test(`verification rejects ${staged ? "staged" : "unstaged"} whitespace without rewriting the index`, (t) => {
		const f = fixture(t);
		const clean = readFileSync(f.readme);
		appendFileSync(f.readme, "\nregression fixture \n");
		if (staged) {
			const added = spawnSync("git", ["add", "README.md"], {
				cwd: f.root,
				env: f.env,
				encoding: "utf8",
			});
			assert.equal(added.status, 0, added.stderr);
			writeFileSync(f.readme, clean);
		}
		const before = readFileSync(f.index);
		const result = f.verify();
		assert.notEqual(result.status, 0);
		assert.match(result.stdout + result.stderr, /trailing whitespace/);
		assert.deepEqual(readFileSync(f.index), before);
	});
}
