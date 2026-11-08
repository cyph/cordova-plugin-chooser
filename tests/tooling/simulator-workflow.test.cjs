const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

test("generated simulator apps set the deployment floor before plugin installation", async (t) => {
	const { prepareSimulatorApp } =
		await import("../../scripts/ios-simulator.mjs");
	const directory = mkdtempSync(join(tmpdir(), "chooser-simulator-config-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "config.xml");
	for (const [input, expected] of [
		[
			"<widget></widget>",
			'<widget><preference name="deployment-target" value="15.0" />\n</widget>',
		],
		[
			'<widget><preference name="deployment-target" value="13.0" /></widget>',
			'<widget><preference name="deployment-target" value="15.0" /></widget>',
		],
		[
			"<widget><preference value='14.5' name='deployment-target'/></widget>",
			"<widget><preference value=\"15.0\" name='deployment-target'/></widget>",
		],
		[
			'<widget><platform name="ios"><preference name="deployment-target" value="15.2" /></platform></widget>',
			null,
		],
		[
			'<widget><preference name="deployment-target" value="18.1.2" /></widget>',
			null,
		],
	]) {
		writeFileSync(path, input);
		prepareSimulatorApp(directory);
		assert.equal(readFileSync(path, "utf8"), expected ?? input);
		prepareSimulatorApp(directory);
		assert.equal(readFileSync(path, "utf8"), expected ?? input);
	}
	for (const input of [
		'<widget><preference name="deployment-target" value="invalid" /></widget>',
		"<widget/>",
	]) {
		writeFileSync(path, input);
		assert.throws(() => prepareSimulatorApp(directory));
		assert.equal(readFileSync(path, "utf8"), input);
	}
});

test("provider investigation is manual, preserves failures and cannot supply required artifacts", () => {
	const workflow = readFileSync(
		join(__dirname, "../../.github/workflows/ios-provider-investigation.yml"),
		"utf8",
	);
	const triggers = workflow.slice(
		workflow.indexOf("\non:"),
		workflow.indexOf("\npermissions:"),
	);
	assert.match(triggers, /workflow_dispatch:/);
	assert.doesNotMatch(triggers, /push:|pull_request:|schedule:|workflow_run:/);
	assert.match(workflow, /framework: \[cordova-ios7, cordova-ios8\]/);
	assert.match(workflow, /device: \[iphone, ipad\]/);
	assert.match(workflow, /fail-fast: false/);
	assert.match(workflow, /chainman run verify-ios-simulator-part/);
	assert.match(workflow, /--investigation-only/);
	assert.match(workflow, /name: investigation-ios-provider-/);
	assert.doesNotMatch(
		workflow,
		/continue-on-error|\|\| true|name: qualification-/,
	);
	assert.match(
		workflow,
		/always\(\) && hashFiles\('\.verification\/reports\/\*\*'\) != ''/,
	);
});

test("main workflow retains PR and manual entry points with only master pushes", () => {
	const workflow = readFileSync(
		join(__dirname, "../../.github/workflows/verify.yml"),
		"utf8",
	);
	const triggers = workflow.slice(
		workflow.indexOf("\non:"),
		workflow.indexOf("\npermissions:"),
	);
	assert.match(triggers, /pull_request:/);
	assert.match(triggers, /workflow_dispatch:/);
	assert.match(triggers, /push:\s+branches: \[master\]/);
	assert.doesNotMatch(triggers, /candidate/);
	assert.doesNotMatch(
		workflow,
		/--investigation-only|ios_diagnostic|diagnose-ios/,
	);
	assert.match(workflow, /pattern: qualification-\*/);
	const simulator = workflow.slice(
		workflow.indexOf("\n  ios-simulator:"),
		workflow.indexOf("\n  qualification:"),
	);
	assert.doesNotMatch(simulator, /continue-on-error/);
	assert.match(simulator, /framework: \[cordova-ios7, cordova-ios8\]/);
	assert.match(simulator, /device: \[iphone, ipad\]/);
	assert.match(simulator, /chainman run verify-ios-simulator-part/);
	assert.match(simulator, /\*-not-started\.json/);
	assert.match(
		simulator,
		/always\(\) && hashFiles\('\.verification\/reports\/\*\*'\) != ''/,
	);
});

test("focused diagnostics remain manual and separate from qualification", () => {
	const workflow = readFileSync(
		join(__dirname, "../../.github/workflows/ios-simulator-diagnostic.yml"),
		"utf8",
	);
	const triggers = workflow.slice(
		workflow.indexOf("\non:"),
		workflow.indexOf("\npermissions:"),
	);
	assert.match(triggers, /workflow_dispatch:/);
	assert.doesNotMatch(triggers, /push:|pull_request:|schedule:|workflow_run:/);
	assert.match(triggers, /options: \[baseline, baseline-intel, modern\]/);
	assert.match(triggers, /options: \[iphone, ipad\]/);
	assert.match(triggers, /options: \[all, dismissal, provider\]/);
	assert.match(workflow, /diagnose-ios-simulator-modern/);
	assert.match(workflow, /macos-26-intel/);
	assert.match(workflow, /name: diagnostics-ios-/);
	assert.doesNotMatch(
		workflow,
		/continue-on-error|\|\| true|name: qualification-/,
	);
	assert.match(workflow, /if: \$\{\{ always\(\) && hashFiles/);
});

test("release comparison is manual, bounded and cannot supply qualification artifacts", () => {
	const workflow = readFileSync(
		join(__dirname, "../../.github/workflows/ios-release-comparison.yml"),
		"utf8",
	);
	const triggers = workflow.slice(
		workflow.indexOf("\non:"),
		workflow.indexOf("\npermissions:"),
	);
	assert.match(triggers, /workflow_dispatch:/);
	assert.doesNotMatch(triggers, /push:|pull_request:|schedule:|workflow_run:/);
	assert.match(workflow, /framework: \[cordova-ios7, cordova-ios8\]/);
	assert.match(workflow, /device: \[iphone, ipad\]/);
	assert.match(workflow, /fail-fast: false/);
	assert.match(workflow, /cancel-in-progress: false/);
	assert.match(workflow, /timeout-minutes: 360/);
	assert.match(workflow, /chainman run compare-ios-releases/);
	assert.match(workflow, /name: comparison-ios-/);
	assert.doesNotMatch(
		workflow,
		/continue-on-error|\|\| true|name: qualification-/,
	);
	assert.match(
		workflow,
		/always\(\) && hashFiles\('\.verification\/reports\/\*\*'\) != ''/,
	);
});
