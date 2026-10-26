const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { version } = require("../../package.json");

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
	const { aggregateReports, requiredChecks } =
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
