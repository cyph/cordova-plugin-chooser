const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

test("qualification requires every successful job, complete reports and the same package", async (t) => {
	const { aggregateReports, requiredChecks } =
		await import("../../scripts/qualification.mjs");
	const directory = mkdtempSync(join(tmpdir(), "chooser-qualification-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const sha = "a".repeat(40);
	const jobs = Object.fromEntries(
		["portable", "android", "android-failures", "ios", "ios-modern"].map(
			(name) => [name, { result: "success" }],
		),
	);
	const reports = Object.entries(requiredChecks).map(([lane, checks]) => ({
		schema: 1,
		lane,
		commit: sha,
		status: "passed",
		checks,
		package: { version: "2.0.0-rc.1", integrity: "sha512-YWJjZA==" },
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
	assert.equal(aggregateReports(directory, sha, jobs).lanes.length, 6);
	for (const result of ["failure", "skipped", "cancelled"]) {
		assert.throws(
			() => aggregateReports(directory, sha, { ...jobs, ios: { result } }),
			/did not succeed/,
		);
	}
	const original = reports[0];
	for (const patch of [
		{ status: "running" },
		{ commit: "b".repeat(40) },
		{ checks: [] },
		{ commands: [{ status: 1 }] },
		{ package: { version: "2.0.0-rc.1", integrity: "sha512-ZGVmZw==" } },
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
