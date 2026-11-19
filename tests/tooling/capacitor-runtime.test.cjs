const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { copyFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const root = resolve(__dirname, "../..");

test("CommonJS Chooser preserves an existing ESM Capacitor registry", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "chooser-capacitor-esm-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const module = join(directory, "core.mjs");
	copyFileSync(require.resolve("@capacitor/core/dist/index.js"), module);
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
		import assert from 'node:assert/strict';
		import {createRequire} from 'node:module';
		import {Capacitor, registerPlugin} from ${JSON.stringify(pathToFileURL(module).href)};
		registerPlugin('ExistingWebPlugin', {web: {}});
		const require = createRequire(${JSON.stringify(join(root, "package.json"))});
		assert.equal(typeof require('cordova-plugin-chooser/capacitor').Chooser.getFile, 'function');
		assert.equal(Capacitor.isPluginAvailable('ExistingWebPlugin'), true);
		assert.equal(Capacitor.isPluginAvailable('Chooser'), true);
		assert.equal(require.resolve('cordova-plugin-chooser/www/chooser'), require.resolve('cordova-plugin-chooser'));
	`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
});

test("the ESM and CommonJS package entry points share Chooser in Node", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
		import assert from 'node:assert/strict';
		import {createRequire} from 'node:module';
		import {Chooser} from 'cordova-plugin-chooser/capacitor';
		import {Capacitor} from '@capacitor/core';
		assert.equal(Capacitor.isPluginAvailable('Chooser'), true);
		assert.equal(Chooser, createRequire(import.meta.url)('cordova-plugin-chooser/capacitor').Chooser);
	`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
});
