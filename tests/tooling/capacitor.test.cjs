const test = require("node:test");
const assert = require("node:assert/strict");
const {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const names = ["@capacitor/core", "@capacitor/android", "@capacitor/cli"];

function fixture(t, { version = "8.5.3", pins = {}, installed = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "chooser-capacitor-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (path, contents) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents);
	};
	const declared = {
		...Object.fromEntries(names.map((name) => [name, version])),
		...pins,
	};
	write(
		join(root, "package.json"),
		JSON.stringify({ devDependencies: declared }),
	);
	for (const name of names)
		write(
			join(root, "node_modules", name, "package.json"),
			JSON.stringify({ name, version: installed[name] ?? declared[name] }),
		);
	const packed = join(root, "packed-plugin");
	write(
		join(packed, "package.json"),
		JSON.stringify({ name: "cordova-plugin-chooser", version: "2.0.0-rc.2" }),
	);
	for (const name of [
		"www/chooser-core.js",
		"src/browser/chooser-web.js",
		"capacitor/index.js",
	])
		write(join(packed, name), "module.exports = {};");
	write(
		join(root, "node_modules/@capacitor/core/dist/index.cjs.js"),
		"module.exports = {};",
	);
	const ownedTest = "app/src/androidTest/java/ChooserTest.java";
	write(join(root, "tests/capacitor", ownedTest), "owned instrumentation");
	write(join(root, "tests/capacitor/settings.gradle"), "owned settings");
	for (const path of ["build/stale", ".gradle/stale", "local.properties"])
		write(join(root, "tests/capacitor", path), "excluded local state");
	const output = join(root, ".verification");
	const directory = join(output, "capacitor");
	write(join(directory, "previous-run"), "stale fixture");
	const calls = [];
	const run = (command, args, cwd, capture, env) => {
		calls.push(args[1]);
		assert.equal(command, "node");
		assert.equal(
			args[0],
			join(root, "node_modules/@capacitor/cli/bin/capacitor"),
		);
		assert.equal(args[2], "android");
		assert.equal(cwd, directory);
		assert.equal(capture, false);
		assert.deepEqual(env, {
			npm_config_offline: "true",
			npm_config_ignore_scripts: "true",
		});
		if (args[1] === "add") {
			for (const path of ["test/Demo.java", "androidTest/Demo.java"])
				write(join(directory, "android/app/src", path), "CLI demonstration");
			write(
				join(directory, "android/app/src/main/res/values/demo.xml"),
				"demo",
			);
		} else {
			assert.equal(args[1], "sync");
			write(
				join(directory, "android/app/src/main/res/xml/config.xml"),
				"<widget />",
			);
			write(
				join(directory, "android/app/src/main/assets/capacitor.plugins.json"),
				JSON.stringify([{ classpath: "com.cyph.cordova.CapacitorChooser" }]),
			);
			write(
				join(
					directory,
					"android/app/src/main/assets/public/cordova_plugins.js",
				),
				"generated bridge",
			);
		}
	};
	return { root, output, run, pack: () => packed, calls, ownedTest };
}

for (const version of ["8.5.2", "8.5.3"]) {
	test(`Capacitor preparation uses matching frozen project version ${version}`, async (t) => {
		const { prepareCapacitor } = await import("../../scripts/capacitor.mjs");
		const f = fixture(t, { version });
		const prepared = prepareCapacitor(f);
		assert.equal(prepared.version, version);
		assert.deepEqual(prepared.env, {
			CHOOSER_NODE_MODULES: join(f.root, "node_modules"),
			CHOOSER_PLUGIN: join(f.root, "packed-plugin"),
		});
		assert.deepEqual(f.calls, ["add", "sync"]);
		const dependencies = JSON.parse(
			readFileSync(join(prepared.directory, "package.json"), "utf8"),
		).dependencies;
		for (const name of names) {
			assert.equal(dependencies[name], version);
			assert.equal(
				realpathSync(join(prepared.directory, "node_modules", name)),
				realpathSync(join(f.root, "node_modules", name)),
			);
		}
		const android = join(prepared.directory, "android");
		assert.equal(
			readFileSync(join(android, f.ownedTest), "utf8"),
			"owned instrumentation",
		);
		assert.equal(
			readFileSync(join(android, "settings.gradle"), "utf8"),
			"owned settings",
		);
		assert.equal(
			readFileSync(
				join(android, "app/src/main/assets/public/cordova_plugins.js"),
				"utf8",
			),
			"generated bridge",
		);
		assert.match(
			readFileSync(
				join(android, "app/src/main/assets/capacitor.plugins.json"),
				"utf8",
			),
			/com\.cyph\.cordova\.CapacitorChooser/,
		);
		for (const path of [
			"app/src/test/Demo.java",
			"app/src/androidTest/Demo.java",
			"app/src/main/res/values/demo.xml",
			"build/stale",
			".gradle/stale",
			"local.properties",
		])
			assert(
				!existsSync(join(android, path)),
				`Retained stale fixture ${path}`,
			);
		assert(!existsSync(join(prepared.directory, "previous-run")));
	});
}

for (const [fault, options, expected] of [
	[
		"mismatched project trio",
		{ pins: { "@capacitor/cli": "8.5.2" } },
		/must match the @capacitor\/core project pin/,
	],
	[
		"mismatched installed trio",
		{ installed: { "@capacitor/android": "8.5.2" } },
		/Installed @capacitor\/android differs from the project pin/,
	],
	[
		"matching stale installation",
		{ installed: Object.fromEntries(names.map((name) => [name, "8.5.2"])) },
		/Installed @capacitor\/core differs from the project pin/,
	],
	[
		"non-exact project pins",
		{ version: "^8.5.3" },
		/Capacitor requires exact project pins/,
	],
]) {
	test(`Capacitor preparation rejects ${fault} before invoking the CLI`, async (t) => {
		const { prepareCapacitor } = await import("../../scripts/capacitor.mjs");
		const f = fixture(t, options);
		assert.throws(() => prepareCapacitor(f), expected);
		assert.deepEqual(f.calls, []);
	});
}
