const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const apple = require("../../chainman/apple.json");
const { version } = require("../../package.json");
const sha = "a".repeat(40);
const api = Promise.all([
	import("../../scripts/qualification.mjs"),
	import("../../scripts/simulator-results.mjs"),
]);

async function fixture(t) {
	const [qualification, simulator] = await api;
	const { requiredChecks, simulatorPartitionChecks, aggregateReports } =
		qualification;
	const directory = mkdtempSync(join(tmpdir(), "chooser-partitions-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const jobs = Object.fromEntries(
		[
			"portable",
			"android",
			"android-failures",
			"ios",
			"ios-modern",
			"ios-simulator",
			"capacitor-android",
		].map((job) => [job, { result: "success" }]),
	);
	const report = (lane, checks) => ({
		schema: 1,
		lane,
		commit: sha,
		status: "passed",
		checks: [...checks],
		package: { version, integrity: "sha512-YWJjZA==" },
		commands: [{ status: 0 }],
	});
	const other = Object.entries(requiredChecks)
		.filter(([lane]) => lane !== "ios-simulator")
		.map(([lane, checks]) => report(lane, checks));
	const parts = simulator.simulatorPartitions.map((partition, index) => ({
		...report("ios-simulator", simulatorPartitionChecks(partition)),
		partition: { ...partition },
		toolchain: {
			apple: { ...apple },
			simulators: [
				{
					alias: partition.framework,
					deviceName:
						partition.device === "iphone" ? "iPhone 17" : "iPad (A16)",
					udid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
					runtime: `com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`,
				},
			],
		},
	}));
	const save = (reports) => {
		rmSync(directory, { recursive: true, force: true });
		reports.forEach((value, index) => {
			const destination = join(directory, String(index));
			mkdirSync(destination, { recursive: true });
			writeFileSync(
				join(destination, "qualification.json"),
				JSON.stringify(value),
			);
		});
	};
	const run = (reports = [...other, ...parts], results = jobs) => {
		save(reports);
		return aggregateReports(directory, sha, results);
	};
	return { ...qualification, ...simulator, other, parts, jobs, run, report };
}

test("partitions preserve all original release cases and reject narrowing arguments", async (t) => {
	const f = await fixture(t);
	assert.equal(f.simulatorPartitions.length, 4);
	for (const partition of f.simulatorPartitions)
		assert.deepEqual(
			f.simulatorPartitionOptions([partition.framework, partition.device]),
			partition,
		);
	for (const args of [
		[],
		["cordova-ios7"],
		["cordova-ios7", "iphone", "--provider-only"],
		["cordova-ios9", "iphone"],
		["cordova-ios7", "../ipad"],
		["cordova-ios7", "iPhone"],
	])
		assert.throws(() => f.simulatorPartitionOptions(args));
	const release = f.simulatorSelection(false);
	assert.equal(release.control.length, 10);
	assert.equal(release.chooser.length, 13);
	assert.equal(
		(release.control.length + release.chooser.length + 7) *
			f.simulatorPartitions.length,
		120,
	);
});

test("all four isolated partitions qualify together and cannot qualify alone", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.run().lanes.sort(), Object.keys(f.requiredChecks).sort());
	for (const part of f.parts)
		assert.throws(() => f.validateReport(part, sha), /cannot qualify alone/);
	for (let count = 0; count < f.parts.length; count++)
		assert.throws(() => f.run([...f.other, ...f.parts.slice(0, count)]));
	assert.throws(() => f.run([...f.other, ...f.parts, f.parts[0]]));
	assert.throws(
		() =>
			f.run([
				...f.other,
				...f.parts,
				f.report("ios-simulator", f.requiredChecks["ios-simulator"]),
			]),
		/Mixed complete and partial/,
	);
	assert.throws(() => f.run([...f.other, ...f.parts, f.other[0]]));
	const relabeledDiagnostic = structuredClone(f.other);
	relabeledDiagnostic[0].diagnostic = { scope: "all" };
	assert.throws(
		() => f.run([...relabeledDiagnostic, ...f.parts]),
		/Diagnostic evidence/,
	);
	const unrelatedPartition = structuredClone(f.other);
	unrelatedPartition[0].partition = f.parts[0].partition;
	assert.throws(
		() => f.run([...unrelatedPartition, ...f.parts]),
		/cannot qualify alone/,
	);
});

test("each partition requires every compile, source-preparation, control and plugin check", async (t) => {
	const f = await fixture(t);
	for (const check of f.parts[0].checks) {
		const bad = structuredClone(f.parts);
		bad[0].checks = bad[0].checks.filter((value) => value !== check);
		assert.throws(
			() => f.run([...f.other, ...bad]),
			/Incomplete simulator partition/,
		);
	}
	for (const checks of [
		[...f.parts[0].checks, f.parts[0].checks[0]],
		[...f.parts[0].checks, "cordova-ios8:ipad"],
	]) {
		const bad = structuredClone(f.parts);
		bad[0].checks = checks;
		assert.throws(() => f.run([...f.other, ...bad]));
	}
});

test("partition identities, pins and owned devices must match their actual scope", async (t) => {
	const f = await fixture(t);
	for (const mutate of [
		(part) => {
			part.partition.device = "other";
		},
		(part) => {
			part.partition.framework = "cordova-ios9";
		},
		(part) => {
			part.partition.scope = "provider";
		},
		(part) => {
			part.diagnostic = { scope: "all" };
		},
		(part) => {
			part.toolchain.apple.iphoneos = "0.0";
		},
		(part) => {
			part.toolchain.simulators[0].alias = "cordova-ios8";
		},
		(part) => {
			part.toolchain.simulators[0].deviceName = "iPad (A16)";
		},
		(part) => {
			part.toolchain.simulators[0].runtime = "other";
		},
		(part) => {
			part.toolchain.simulators[0].udid = "invalid";
		},
		(part) => {
			part.toolchain.simulators.push(part.toolchain.simulators[0]);
		},
	]) {
		const bad = structuredClone(f.parts);
		mutate(bad[0]);
		assert.throws(() => f.run([...f.other, ...bad]));
	}
	const duplicate = structuredClone(f.parts);
	duplicate[3] = structuredClone(duplicate[0]);
	duplicate[3].toolchain.simulators[0].udid =
		f.parts[3].toolchain.simulators[0].udid;
	assert.throws(
		() => f.run([...f.other, ...duplicate]),
		/Missing or duplicate simulator partitions/,
	);
	const reused = structuredClone(f.parts);
	reused[1].toolchain.simulators[0].udid =
		reused[0].toolchain.simulators[0].udid;
	assert.throws(() => f.run([...f.other, ...reused]), /reused a device/);
});

test("partition evidence cannot mix revisions, package identities or failed commands", async (t) => {
	const f = await fixture(t);
	for (const patch of [
		{ commit: "b".repeat(40) },
		{ schema: 2 },
		{ status: "failed" },
		{ commands: [] },
		{ commands: [{ status: 1 }] },
		{ package: { version, integrity: "sha512-ZGVmZw==" } },
		{ package: { version: version + "-other", integrity: "sha512-YWJjZA==" } },
	]) {
		const bad = structuredClone(f.parts);
		Object.assign(bad[0], patch);
		assert.throws(() => f.run([...f.other, ...bad]));
	}
	for (const result of ["failure", "skipped", "cancelled", undefined])
		assert.throws(
			() => f.run(undefined, { ...f.jobs, "ios-simulator": { result } }),
			/did not succeed/,
		);
});
