const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { version } = require("../../package.json");

test("simulator evidence requires every case, with no failures or skips", async () => {
	const { checkSimulatorResults, simulatorCases } =
		await import("../../scripts/simulator-results.mjs");
	const summary = {
		totalTestCount: 7,
		passedTests: 7,
		failedTests: 0,
		skippedTests: 0,
	};
	checkSimulatorResults(summary, simulatorCases);
	for (const patch of [
		{ totalTestCount: 0 },
		{ passedTests: 6 },
		{ failedTests: 1 },
		{ skippedTests: 1 },
	])
		assert.throws(() =>
			checkSimulatorResults({ ...summary, ...patch }, simulatorCases),
		);
	assert.throws(
		() => checkSimulatorResults(summary, simulatorCases.slice(1)),
		/Missing simulator case/,
	);
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
