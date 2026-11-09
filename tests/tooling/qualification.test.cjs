const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { version } = require("../../package.json");

test("captured xcresult trees retain exact case identities and failure outcomes", async () => {
	const {
		checkSimulatorResults,
		simulatorCaseRecords,
		simulatorCases,
		controlCases,
	} = await import("../../scripts/simulator-results.mjs");
	for (const [label, required] of [
		// Captured RC1 evidence retains its historical callback case names.
		[
			"chooser",
			simulatorCases
				.filter(
					(id) =>
						!id.startsWith("ChooserBridgeTests/") &&
						(!id.startsWith("ChooserPickerTests/") ||
							[
								"ChooserPickerTests/testAdaptiveDismissalAndStaleCallbacks()",
								"ChooserPickerTests/testResetAndDuplicateSelectionCannotSettleANewerRequest()",
								"ChooserPickerTests/testMovieWildcardIncludesMP4AndQuickTime()",
							].includes(id)),
				)
				.map((id) => id.replace("ScopedReopen", "CallbackReopen")),
		],
		// This captured bundle predates the additional gesture controls.
		[
			"control",
			controlCases.filter(
				(id) =>
					![
						"UIKitControlTests/testPlainSheetSwipe()",
						"UIKitControlTests/testSystemDelegateSwipe()",
					].includes(id),
			),
		],
	]) {
		const read = (part) =>
			JSON.parse(
				readFileSync(
					join(__dirname, "fixtures", "xcresult", `${label}-${part}.json`),
					"utf8",
				),
			);
		const tests = read("tests");
		const summary = read("summary");
		const records = simulatorCaseRecords(tests);
		assert.deepEqual(records.map(({ id }) => id).sort(), [...required].sort());
		assert.equal(
			records.filter(({ result }) => result === "Failed").length,
			summary.failedTests,
		);
		assert(
			records
				.filter(({ result }) => result === "Failed")
				.every(({ failures }) => failures.length > 0),
		);
		assert.throws(
			() => checkSimulatorResults(summary, tests, required),
			/Unsuccessful case/,
		);
	}
});

test("focused simulator selection cannot narrow release qualification", async () => {
	const {
		simulatorOptions,
		simulatorSelection,
		simulatorTestArguments,
		simulatorCases,
		controlCases,
	} = await import("../../scripts/simulator-results.mjs");
	assert.deepEqual(simulatorOptions([], false), {
		profile: "baseline",
		device: "iphone",
		scope: "all",
	});
	assert.deepEqual(simulatorOptions(["--dismissal-only"], true), {
		profile: "baseline",
		device: "iphone",
		scope: "dismissal",
	});
	assert.deepEqual(
		simulatorOptions(["modern", "ipad", "--dismissal-only"], true),
		{ profile: "modern", device: "ipad", scope: "dismissal" },
	);
	for (const args of [["--dismissal-only"], ["modern"], ["baseline", "ipad"]])
		assert.throws(() => simulatorOptions(args, false));
	for (const args of [
		["--unknown"],
		["--presentation-only"],
		["--dismissal-only", "--dismissal-only"],
		["other"],
		["baseline", "other"],
		["baseline", "ipad", "extra"],
	])
		assert.throws(() => simulatorOptions(args, true));
	assert.deepEqual(simulatorSelection(false), {
		control: controlCases,
		chooser: simulatorCases,
	});
	const completeDiagnostic = simulatorSelection(true);
	assert.deepEqual(completeDiagnostic.chooser, simulatorCases);
	assert.deepEqual(
		completeDiagnostic.control.slice(0, controlCases.length),
		controlCases,
	);
	assert.deepEqual(
		completeDiagnostic.control.slice(controlCases.length),
		["JSON", "CSV", "PDF", "Image", "MP4", "MOV"].map(
			(format) => `UIKitControlTests/testSystemDelegate${format}()`,
		),
	);
	assert.equal(
		new Set(completeDiagnostic.control).size,
		completeDiagnostic.control.length,
	);
	assert.throws(() => simulatorSelection(false, "dismissal"));
	assert.throws(() => simulatorSelection(true, "other"));
	const focus = simulatorSelection(true, "dismissal");
	assert.deepEqual(focus.control, [
		"UIKitControlTests/testCancel()",
		"UIKitControlTests/testSwipe()",
		"UIKitControlTests/testPlainSheetSwipe()",
		"UIKitControlTests/testSystemDelegateSwipe()",
	]);
	assert.deepEqual(focus.chooser, [
		"ChooserUITests/testCancelPromiseReopen()",
		"ChooserUITests/testCancelScopedReopen()",
		"ChooserUITests/testSwipePromiseReopen()",
		"ChooserUITests/testSwipeScopedReopen()",
	]);
	assert.equal(
		simulatorTestArguments(controlCases, "all").length,
		controlCases.length,
	);
	for (const scope of ["provider"]) {
		assert.deepEqual(simulatorOptions([`--${scope}-only`], true).scope, scope);
		assert.throws(() => simulatorOptions([`--${scope}-only`], false));
		assert.throws(() => simulatorSelection(false, scope));
		const investigation = simulatorSelection(true, scope);
		assert(
			investigation.control.length > 0 && investigation.chooser.length > 0,
		);
		assert.equal(
			simulatorTestArguments(investigation.control, scope).length,
			investigation.control.length,
		);
		for (const id of [...investigation.control, ...investigation.chooser]) {
			assert(![...controlCases, ...simulatorCases].includes(id));
		}
	}
	assert.throws(() =>
		simulatorOptions(["--provider-only", "--dismissal-only"], true),
	);
	assert.deepEqual(simulatorTestArguments(focus.control, "dismissal"), [
		"-only-testing:UIKitControlTests/UIKitControlTests/testCancel",
		"-only-testing:UIKitControlTests/UIKitControlTests/testSwipe",
		"-only-testing:UIKitControlTests/UIKitControlTests/testPlainSheetSwipe",
		"-only-testing:UIKitControlTests/UIKitControlTests/testSystemDelegateSwipe",
	]);
});

test("failed simulator case details remain available for diagnostic output", async () => {
	const { simulatorCaseRecords } =
		await import("../../scripts/simulator-results.mjs");
	assert.deepEqual(
		simulatorCaseRecords({
			testNodes: [
				{
					nodeType: "Test Suite",
					children: [
						{
							nodeType: "Test Case",
							nodeIdentifier: "ChooserUITests/testCSV()",
							result: "Failed",
							children: [
								{
									nodeType: "Failure Message",
									name: "Picker presentation did not complete: 2",
								},
							],
						},
					],
				},
			],
		}),
		[
			{
				id: "ChooserUITests/testCSV()",
				result: "Failed",
				failures: ["Picker presentation did not complete: 2"],
			},
		],
	);
});

test("simulator evidence requires exact passing case identities and consistent totals", async () => {
	const {
		checkSimulatorResults,
		simulatorCases,
		controlCases,
		simulatorPartitions,
		simulatorPartitionSelection,
	} = await import("../../scripts/simulator-results.mjs");
	const tree = (ids) => ({
		testNodes: [
			{
				nodeType: "Test Plan",
				children: [
					{
						nodeType: "Destination",
						children: ids.map((nodeIdentifier) => ({
							nodeType: "Test Case",
							nodeIdentifier,
							result: "Passed",
						})),
					},
				],
			},
		],
	});
	const summary = (ids) => ({
		totalTestCount: ids.length,
		passedTests: ids.length,
		failedTests: 0,
		skippedTests: 0,
	});
	const selections = simulatorPartitions.flatMap((partition) =>
		["required", "investigation", "full"].flatMap((suite) =>
			Object.values(simulatorPartitionSelection(partition, suite)).filter(
				(ids) => ids.length > 0,
			),
		),
	);
	for (const required of selections) {
		checkSimulatorResults(summary(required), tree(required), required);
		for (const patch of [
			{ totalTestCount: 0 },
			{ totalTestCount: required.length + 1 },
			{ passedTests: 0 },
			{ failedTests: 1 },
			{ skippedTests: 1 },
			{ expectedFailures: 1 },
		])
			assert.throws(() =>
				checkSimulatorResults(
					{ ...summary(required), ...patch },
					tree(required),
					required,
				),
			);
		for (const ids of [
			required.slice(1),
			[...required, required[0]],
			required.map((id) => id.replace("()", "Replacement()")),
			required.map((id) => "OtherSuite/" + id.split("/")[1]),
		])
			assert.throws(() =>
				checkSimulatorResults(summary(ids), tree(ids), required),
			);
		// Passing UI, control or native cases from another suite cannot fill in
		// or extend this suite's exact evidence, even with consistent totals.
		for (const extra of [...simulatorCases, ...controlCases].filter(
			(id) => !required.includes(id),
		)) {
			for (const ids of [
				[...required, extra],
				[extra, ...required.slice(1)],
			])
				assert.throws(
					() => checkSimulatorResults(summary(ids), tree(ids), required),
					/Missing or unexpected simulator case/,
				);
		}
		for (const result of ["Failed", "Skipped", "Expected Failure", undefined]) {
			const data = tree(required);
			data.testNodes[0].children[0].children[0].result = result;
			assert.throws(() =>
				checkSimulatorResults(summary(required), data, required),
			);
		}
		for (const data of [
			required,
			{ testNodes: null },
			{ testNodes: [{ children: "bad" }] },
			{
				testNodes: [{ nodeType: "Failure Message", name: required.join(" ") }],
			},
		])
			assert.throws(() =>
				checkSimulatorResults(summary(required), data, required),
			);
	}
});

test("qualification requires every successful job, complete reports and the same package", async (t) => {
	const { aggregateReports, requiredChecks, validateReport } =
		await import("../../scripts/qualification.mjs");
	const { simulatorManifest } =
		await import("../../scripts/simulator-results.mjs");
	const directory = mkdtempSync(join(tmpdir(), "chooser-qualification-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const sha = "a".repeat(40);
	const jobs = Object.fromEntries(
		[
			"portable",
			"android",
			"android-failures",
			"ios",
			"ios-modern",
			"ios-simulator",
			"capacitor-android",
		].map((name) => [name, { result: "success" }]),
	);
	const reports = Object.entries(requiredChecks).map(([lane, checks]) => ({
		schema: 1,
		lane,
		commit: sha,
		status: "passed",
		checks,
		package: { version, integrity: "sha512-YWJjZA==" },
		commands: [{ status: 0 }],
		...(lane === "ios-simulator"
			? { simulator: simulatorManifest("required") }
			: {}),
	}));
	const save = (report) => {
		mkdirSync(join(directory, report.lane), { recursive: true });
		writeFileSync(
			join(directory, report.lane, "qualification.json"),
			JSON.stringify(report),
		);
	};
	assert.throws(
		() =>
			validateReport({ ...reports[0], lane: "ios-simulator-diagnostic" }, sha),
		/Unknown qualification lane/,
	);
	reports.forEach(save);
	const qualified = aggregateReports(directory, sha, jobs);
	assert.equal(qualified.lanes.length, 8);
	assert.equal(qualified.integrity, reports[0].package.integrity);
	assert.equal(qualified.commit, sha);
	const output = join(directory, "github-output");
	const qualify = () =>
		spawnSync(
			process.execPath,
			[join(__dirname, "../../scripts/verify.mjs"), "qualification"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CHOOSER_REPORTS_ROOT: directory,
					GITHUB_SHA: sha,
					CHOOSER_JOB_RESULTS: JSON.stringify(jobs),
					GITHUB_OUTPUT: output,
				},
			},
		);
	const successful = qualify();
	assert.equal(successful.status, 0, successful.stdout + successful.stderr);
	assert.equal(
		readFileSync(output, "utf8"),
		`integrity=${qualified.integrity}\n`,
	);
	const simulator = reports.find((report) => report.lane === "ios-simulator");
	save({
		...simulator,
		checks: simulator.checks.filter((check) => !check.endsWith(":compile")),
	});
	assert.throws(
		() => aggregateReports(directory, sha, jobs),
		/Missing ios-simulator check/,
	);
	assert.equal(simulator.checks.length, 11);
	for (const check of simulator.checks) {
		save({
			...simulator,
			checks: simulator.checks.filter((value) => value !== check),
		});
		assert.throws(
			() => aggregateReports(directory, sha, jobs),
			/Missing ios-simulator check/,
		);
	}
	const { simulatorSuiteChecks } =
		await import("../../scripts/qualification.mjs");
	for (const suite of ["investigation", "full"]) {
		const checks = simulatorSuiteChecks(suite);
		// Reject both honest full/manual manifests and reports relabeled as
		// required while still claiming provider/control check coverage.
		for (const manifest of [
			simulatorManifest(suite),
			simulatorManifest("required"),
		]) {
			save({ ...simulator, checks, simulator: manifest });
			assert.throws(
				() => aggregateReports(directory, sha, jobs),
				/manifest|unexpected simulator coverage/,
			);
		}
	}
	for (const extra of simulatorSuiteChecks("full").filter(
		(check) => !simulator.checks.includes(check),
	)) {
		save({ ...simulator, checks: [...simulator.checks, extra] });
		assert.throws(
			() => aggregateReports(directory, sha, jobs),
			/unexpected simulator coverage/,
		);
	}
	for (const patch of [
		{ diagnostic: { scope: "all" } },
		{ diagnostic: false },
		{ investigation: true },
		{ investigation: false },
	]) {
		save({ ...simulator, ...patch });
		assert.throws(
			() => aggregateReports(directory, sha, jobs),
			/Diagnostic evidence|Investigation evidence/,
		);
	}
	save(simulator);
	for (const result of ["failure", "skipped", "cancelled"]) {
		assert.throws(
			() => aggregateReports(directory, sha, { ...jobs, ios: { result } }),
			/did not succeed/,
		);
	}
	const original = reports[0];
	save({
		...original,
		package: { ...original.package, version: `${version}-unexpected` },
	});
	assert.throws(
		() => aggregateReports(directory, sha, jobs),
		/Unexpected candidate version/,
	);
	for (const patch of [
		{ status: "running" },
		{ commit: "b".repeat(40) },
		{ checks: [] },
		{ commands: [{ status: 1 }] },
		{ package: { version, integrity: "sha512-ZGVmZw==" } },
	]) {
		save({ ...original, ...patch });
		assert.throws(() => aggregateReports(directory, sha, jobs));
	}
	writeFileSync(output, "");
	assert.notEqual(qualify().status, 0);
	assert.equal(
		readFileSync(output, "utf8"),
		"",
		"A mismatched package cannot expose signing integrity",
	);
	save(original);
	rmSync(join(directory, "ios"), { recursive: true });
	assert.throws(
		() => aggregateReports(directory, sha, jobs),
		/Missing or duplicate/,
	);
});
