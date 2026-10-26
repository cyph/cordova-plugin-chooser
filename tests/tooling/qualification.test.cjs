const test = require("node:test");
const assert = require("node:assert/strict");
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
		["chooser", simulatorCases],
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
		"ChooserUITests/testCancelCallbackReopen()",
		"ChooserUITests/testSwipePromiseReopen()",
		"ChooserUITests/testSwipeCallbackReopen()",
	]);
	assert.equal(
		simulatorTestArguments(controlCases, "all").length,
		controlCases.length,
	);
	for (const scope of ["provider", "presentation"]) {
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
		simulatorOptions(["--provider-only", "--presentation-only"], true),
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
	const { checkSimulatorResults, simulatorCases, controlCases } =
		await import("../../scripts/simulator-results.mjs");
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
	for (const required of [simulatorCases, controlCases]) {
		checkSimulatorResults(summary(required), tree(required), required);
		for (const patch of [
			{ totalTestCount: 0 },
			{ totalTestCount: required.length + 1 },
			{ passedTests: 0 },
			{ failedTests: 1 },
			{ skippedTests: 1 },
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
	assert.equal(aggregateReports(directory, sha, jobs).lanes.length, 8);
	const simulator = reports.find((report) => report.lane === "ios-simulator");
	save({
		...simulator,
		checks: simulator.checks.filter((check) => !check.endsWith(":compile")),
	});
	assert.throws(
		() => aggregateReports(directory, sha, jobs),
		/Missing ios-simulator check/,
	);
	const preparationChecks = simulator.checks.filter(
		(check) => check.endsWith(":provider-setup") || check.includes(":seed-"),
	);
	assert.equal(
		preparationChecks.length,
		28,
		"Each combination requires provider initialization and all six system-created documents",
	);
	for (const check of preparationChecks) {
		save({
			...simulator,
			checks: simulator.checks.filter((value) => value !== check),
		});
		assert.throws(
			() => aggregateReports(directory, sha, jobs),
			/Missing ios-simulator check/,
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
	save(original);
	rmSync(join(directory, "ios"), { recursive: true });
	assert.throws(
		() => aggregateReports(directory, sha, jobs),
		/Missing or duplicate/,
	);
});
