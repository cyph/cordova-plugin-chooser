const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, isAbsolute, join } = require("node:path");

function executable(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		const path = join(directory, name);
		try {
			accessSync(path, constants.X_OK);
			if (statSync(path).isFile()) return realpathSync(path);
		} catch {}
	}
	assert.fail(`Missing ${name} in the fresh Nix profile`);
}

test("native pnpm supplies node-gyp to lifecycle scripts without an ambient installation", (t) => {
	const pnpm = executable("pnpm");
	const shell = executable("sh");
	assert.match(pnpm, /^\/nix\/store\//, "Use the freshly built Nix pnpm");
	assert.match(realpathSync(process.execPath), /^\/nix\/store\//);
	const directory = mkdtempSync(join(tmpdir(), "chooser-pnpm-node-gyp-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const bin = join(directory, "bin");
	const home = join(directory, "home");
	mkdirSync(bin);
	mkdirSync(home);
	symlinkSync(process.execPath, join(bin, "node"));
	symlinkSync(shell, join(bin, "sh"));
	// Fail explicitly if pnpm uses the inherited PATH instead of its own payload.
	writeFileSync(
		join(bin, "node-gyp"),
		`#!${shell}\necho 'Unexpected ambient node-gyp fallback' >&2\nexit 97\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: "chooser-pnpm-node-gyp-probe",
			version: "1.0.0",
			private: true,
			scripts: { probe: "node-gyp --version && node probe.cjs" },
		}),
	);
	writeFileSync(
		join(directory, "pnpm-workspace.yaml"),
		"packages:\n  - .\nverifyDepsBeforeRun: false\n",
	);
	writeFileSync(
		join(directory, "probe.cjs"),
		`const assert = require("node:assert/strict");
const { readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const entry = process.env.npm_config_node_gyp;
assert(entry, "pnpm must select its bundled node-gyp entry point");
const metadata = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
writeFileSync("probe.json", JSON.stringify({ entry: realpathSync(entry), version: metadata.version }));
`,
	);
	// Start outside the checkout with no inherited npm/pnpm config, Node options,
	// credentials, user rc files or ambient tools. No install, compiler or network
	// is needed: the lifecycle command asks node-gyp only for its version.
	const options = {
		cwd: directory,
		env: {
			PATH: bin,
			HOME: home,
			SHELL: join(bin, "sh"),
			TMPDIR: directory,
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
			XDG_DATA_HOME: join(home, "data"),
			CI: "true",
		},
		encoding: "utf8",
		timeout: 30_000,
	};
	const fallback = spawnSync(
		join(bin, "sh"),
		["-c", "node-gyp --version"],
		options,
	);
	assert.ifError(fallback.error);
	assert.equal(
		fallback.status,
		97,
		"The fallback must never satisfy the probe",
	);
	const result = spawnSync(pnpm, ["--offline", "run", "probe"], options);
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const observed = JSON.parse(
		readFileSync(join(directory, "probe.json"), "utf8"),
	);
	assert.match(
		observed.entry,
		/^\/nix\/store\/[^/]+\/libexec\/pnpm\/dist\/node_modules\/node-gyp\/bin\/node-gyp\.js$/,
	);
	assert(result.stdout.split(/\r?\n/).includes(`v${observed.version}`));
});
