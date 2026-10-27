import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	simulatorDocuments,
	simulatorPartitions,
	simulatorPartitionOptions,
} from "./simulator-results.mjs";

const version = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export const requiredChecks = {
	portable: ["contracts", "types", "tooling", "privacy", "package"],
	browser: ["package", "browsers", "reinstall"],
	android: [
		"package",
		...["android", "android15"].flatMap((name) =>
			[
				"api24",
				"api28",
				"api30",
				"api33",
				"api35",
				"lint",
				"debug",
				"release",
				"reinstall",
			].map((check) => `${name}:${check}`),
		),
	],
	"android-failures": ["package", "dependency-failures"],
	"capacitor-android": ["package", "api33-bridge"],
	"ios-simulator": [
		"package",
		"cordova-ios7:compile",
		"cordova-ios8:compile",
		...["cordova-ios7", "cordova-ios8"].flatMap((alias) =>
			["iphone", "ipad"].flatMap((device) => [
				`${alias}:${device}:provider-setup`,
				...simulatorDocuments.map(
					({ format }) => `${alias}:${device}:seed-${format.toLowerCase()}`,
				),
				`${alias}:${device}:native-control`,
				`${alias}:${device}`,
			]),
		),
	],
	ios: [
		"package",
		"foundation",
		...["cordova-ios7", "cordova-ios8"].flatMap((name) =>
			["debug", "reinstall", "release"].map((check) => `${name}:${check}`),
		),
	],
};
requiredChecks["ios-modern"] = [
	...requiredChecks.ios,
	"address-sanitizer",
	"thread-sanitizer",
];

export function simulatorPartitionChecks(partition) {
	simulatorPartitionOptions([partition.framework, partition.device]);
	const prefix = `${partition.framework}:${partition.device}`;
	return requiredChecks["ios-simulator"].filter(
		(check) =>
			check === "package" ||
			check.endsWith(":compile") ||
			check === prefix ||
			check.startsWith(`${prefix}:`),
	);
}

function validateReportBase(report, sha) {
	assert.equal(report.schema, 1, "Unsupported qualification report");
	assert.equal(report.commit, sha, "Qualification revision mismatch");
	assert.equal(report.status, "passed", `Unsuccessful lane: ${report.lane}`);
	assert(
		Object.hasOwn(requiredChecks, report.lane),
		"Unknown qualification lane",
	);
	assert(
		!Object.hasOwn(report, "diagnostic"),
		"Diagnostic evidence cannot satisfy release qualification",
	);
	assert.match(
		report.package?.integrity ?? "",
		/^sha512-[A-Za-z0-9+/]+={0,2}$/,
	);
	assert.equal(
		report.package?.version,
		version,
		"Unexpected candidate version",
	);
	assert(
		report.commands.length > 0 &&
			report.commands.every((command) => command.status === 0),
		`Failed or missing commands in ${report.lane}`,
	);
}

export function validateReport(report, sha) {
	validateReportBase(report, sha);
	assert(
		!Object.hasOwn(report, "partition"),
		"A partial simulator report cannot qualify alone",
	);
	for (const check of requiredChecks[report.lane])
		assert(
			report.checks.includes(check),
			`Missing ${report.lane} check: ${check}`,
		);
}

function validateSimulatorPartitions(parts, sha) {
	assert.equal(
		parts.length,
		simulatorPartitions.length,
		"Missing or duplicate simulator partitions",
	);
	const identities = [];
	const devices = [];
	const apple = JSON.parse(
		readFileSync(new URL("../chainman/apple.json", import.meta.url), "utf8"),
	);
	for (const part of parts) {
		validateReportBase(part, sha);
		assert.equal(part.lane, "ios-simulator");
		assert.deepEqual(Object.keys(part.partition).sort(), [
			"device",
			"framework",
		]);
		const identity = simulatorPartitionOptions([
			part.partition.framework,
			part.partition.device,
		]);
		identities.push(`${identity.framework}:${identity.device}`);
		const expected = simulatorPartitionChecks(identity);
		assert.equal(
			new Set(part.checks).size,
			part.checks.length,
			"Duplicate partition checks",
		);
		assert.deepEqual(
			[...part.checks].sort(),
			expected.sort(),
			"Incomplete simulator partition",
		);
		assert.deepEqual(
			part.toolchain?.apple,
			apple,
			"Partition Apple toolchain mismatch",
		);
		assert.equal(
			part.toolchain?.simulators?.length,
			1,
			"A partition must own exactly one simulator",
		);
		const simulator = part.toolchain.simulators[0];
		assert.equal(simulator.alias, identity.framework);
		assert.equal(
			simulator.deviceName,
			identity.device === "iphone" ? "iPhone 17" : "iPad (A16)",
		);
		assert.match(
			simulator.udid,
			/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
		);
		assert.equal(
			simulator.runtime,
			`com.apple.CoreSimulator.SimRuntime.iOS-${apple.iphoneos.replaceAll(".", "-")}`,
		);
		devices.push(simulator.udid);
	}
	assert.deepEqual(
		identities.sort(),
		simulatorPartitions
			.map((part) => `${part.framework}:${part.device}`)
			.sort(),
		"Missing or duplicate simulator partitions",
	);
	assert.equal(
		new Set(devices).size,
		parts.length,
		"Simulator partitions reused a device",
	);
	assert.equal(
		new Set(parts.map((part) => part.package.integrity)).size,
		1,
		"Package integrity differs across partitions",
	);
	const checks = new Set(parts.flatMap((part) => part.checks));
	for (const check of requiredChecks["ios-simulator"])
		assert(checks.has(check), `Missing ios-simulator check: ${check}`);
}

export function aggregateReports(directory, sha, results) {
	assert.match(sha, /^[a-f0-9]{40}$/);
	const jobs = [
		"portable",
		"android",
		"android-failures",
		"ios",
		"ios-modern",
		"ios-simulator",
		"capacitor-android",
	];
	for (const job of jobs)
		assert.equal(
			results[job]?.result,
			"success",
			`Required job did not succeed: ${job}`,
		);
	const reports = [];
	function visit(path) {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const file = join(path, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.name === "qualification.json")
				reports.push(JSON.parse(readFileSync(file, "utf8")));
		}
	}
	visit(directory);
	const parts = reports.filter(
		(report) =>
			report.lane === "ios-simulator" && Object.hasOwn(report, "partition"),
	);
	let completeReports = reports;
	if (parts.length) {
		assert.equal(
			reports.filter((report) => report.lane === "ios-simulator").length,
			parts.length,
			"Mixed complete and partial simulator reports",
		);
		validateSimulatorPartitions(parts, sha);
		completeReports = reports.filter((report) => !parts.includes(report));
	}
	const lanes = completeReports.map((report) => report.lane);
	if (parts.length) lanes.push("ios-simulator");
	assert.equal(
		lanes.length,
		Object.keys(requiredChecks).length,
		"Missing or duplicate lane reports",
	);
	assert.equal(new Set(lanes).size, lanes.length, "Duplicate lane reports");
	for (const report of completeReports) validateReport(report, sha);
	assert.equal(
		new Set(reports.map((report) => report.package.integrity)).size,
		1,
		"Package integrity differs across lanes",
	);
	return {
		commit: sha,
		integrity: reports[0].package.integrity,
		lanes,
	};
}
