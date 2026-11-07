const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const hook = require("../../src/hooks/ios-target");
const { createRequire } = require("node:module");
const cordovaRequire = createRequire(require.resolve("cordova/package.json"));
const common = createRequire(
	cordovaRequire.resolve("cordova-lib/package.json"),
)("cordova-common");

test("iOS deployment validation uses platform preference and never rewrites application configuration", () => {
	const directory = mkdtempSync(join(tmpdir(), "chooser-ios-target-"));
	try {
		const config = join(directory, "config.xml");
		for (const [preferences, accepted] of [
			["", false],
			['<preference name="deployment-target" value="14.9" />', false],
			['<preference name="deployment-target" value="15.0" />', true],
			['<preference name="deployment-target" value="19.1.2" />', true],
			['<preference name="deployment-target" value="15oops" />', false],
			[
				'<preference name="deployment-target" value="15.0" /><platform name="ios"><preference name="deployment-target" value="14.0" /></platform>',
				false,
			],
			[
				'<preference name="deployment-target" value="12.0" /><platform name="ios"><preference name="deployment-target" value="16.0" /></platform>',
				true,
			],
		]) {
			const source = `<widget id="test.chooser" version="1.0.0" xmlns="http://www.w3.org/ns/widgets">${preferences}</widget>`;
			writeFileSync(config, source);
			const context = {
				opts: { projectRoot: directory, cordova: { platforms: ["ios"] } },
				requireCordovaModule(name) {
					assert.equal(name, "cordova-common");
					return common;
				},
			};
			if (accepted) hook(context);
			else assert.throws(() => hook(context), /requires iOS 15/);
			assert.equal(readFileSync(config, "utf8"), source);
		}
		hook({
			opts: { projectRoot: directory, cordova: { platforms: ["android"] } },
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
