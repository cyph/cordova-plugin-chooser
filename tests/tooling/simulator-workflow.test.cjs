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
	assert.match(
		workflow,
		/pattern: qualification-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\*/,
	);
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

test("qualification artifacts and signer input are isolated to the exact run attempt", () => {
	const workflow = readFileSync(
		join(__dirname, "../../.github/workflows/verify.yml"),
		"utf8",
	);
	const transfers = [
		...workflow.matchAll(
			/uses: actions\/(upload|download)-artifact@[^\n]+\n([\s\S]*?)(?=\n      - |\n  [a-z][\w-]*:|$)/g,
		),
	].map(([, direction, body]) => ({
		direction,
		name: body.match(/^          name: (.+)$/m)?.[1],
		pattern: body.match(/^          pattern: (.+)$/m)?.[1],
	}));
	const uploads = transfers.filter(({ direction }) => direction === "upload");
	assert.equal(uploads.length, 9);
	assert.doesNotMatch(workflow, /overwrite:/);
	for (const { name } of uploads) {
		assert(
			name.includes("${{ github.run_id }}"),
			"Every artifact identifies its run",
		);
		assert(
			name.includes("${{ github.run_attempt }}"),
			"Every artifact identifies its attempt",
		);
	}
	const render = (
		template,
		run = "123",
		attempt = "2",
		framework = "cordova-ios7",
		device = "iphone",
	) =>
		template.replace(
			/\$\{\{ ([\w.]+) \}\}/g,
			(_, key) =>
				({
					"github.run_id": run,
					"github.run_attempt": attempt,
					"matrix.framework": framework,
					"matrix.device": device,
				})[key],
		);
	const names = (run, attempt) =>
		uploads.flatMap(({ name }) =>
			name.includes("matrix.framework")
				? ["cordova-ios7", "cordova-ios8"].flatMap((framework) =>
						["iphone", "ipad"].map((device) =>
							render(name, run, attempt, framework, device),
						),
					)
				: [render(name, run, attempt)],
		);
	const downloads = transfers.filter(
		({ direction }) => direction === "download",
	);
	assert.equal(downloads.length, 2);
	const aggregate = downloads.find(({ pattern }) => pattern);
	assert(aggregate, "Qualification must select the current attempt's reports");
	const matches = (name) =>
		name.startsWith(render(aggregate.pattern).slice(0, -1));
	assert(aggregate.pattern.endsWith("-*"));
	const current = names("123", "2");
	assert.equal(
		new Set(current).size,
		current.length,
		"Every lane and partition keeps distinct evidence",
	);
	assert.equal(
		current.filter(matches).length,
		10,
		"Six lanes and four simulator partitions qualify together",
	);
	for (const other of [...names("123", "1"), ...names("124", "2")])
		assert(
			!matches(other),
			`Qualification must reject other run/attempt artifact ${other}`,
		);
	const signer = downloads.find(({ name }) => name);
	assert(signer, "Signer must download one exact portable artifact");
	assert.equal(render(signer.name), "qualification-123-2-portable");
	assert(current.includes(render(signer.name)));
	assert(!names("123", "1").includes(render(signer.name)));
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
	const matrix = workflow.match(
		/fromJSON\(\(inputs\.experiment == 'metadata-regression' \|\| inputs\.experiment == 'metadata-restoration'\) && '([^']+)' \|\| inputs\.experiment == 'metadata-mode' && '([^']+)' \|\| '([^']+)'\)/,
	);
	assert(matrix, "Expected explicit bounded experiment matrices");
	assert.deepEqual(JSON.parse(matrix[1]), [
		{ framework: "cordova-ios8", device: "ipad" },
		{ framework: "cordova-ios7", device: "ipad" },
	]);
	assert.deepEqual(JSON.parse(matrix[2]), [
		{ framework: "cordova-ios8", device: "ipad" },
	]);
	assert.deepEqual(
		JSON.parse(matrix[3]),
		["cordova-ios7", "cordova-ios8"].flatMap((framework) =>
			["iphone", "ipad"].map((device) => ({ framework, device })),
		),
	);
	assert.match(
		triggers,
		/options:\s*\[\s*releases,\s*metadata-mode,\s*metadata-regression,\s*metadata-restoration,?\s*\]/,
	);
	assert.match(
		workflow,
		/COMPARISON_EXPERIMENT: \$\{\{ inputs.experiment \}\}/,
	);
	assert.match(workflow, /"\$COMPARISON_EXPERIMENT"/);
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
