import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simulatorDocuments } from "./simulator-results.mjs";

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
				`${alias}:${device}:source-restart`,
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

export function validateReport(report, sha) {
	assert.equal(report.schema, 1, "Unsupported qualification report");
	assert.equal(report.commit, sha, "Qualification revision mismatch");
	assert.equal(report.status, "passed", `Unsuccessful lane: ${report.lane}`);
	assert(
		Object.hasOwn(requiredChecks, report.lane),
		"Unknown qualification lane",
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
	for (const check of requiredChecks[report.lane])
		assert(
			report.checks.includes(check),
			`Missing ${report.lane} check: ${check}`,
		);
	assert(
		report.commands.length > 0 &&
			report.commands.every((command) => command.status === 0),
		`Failed or missing commands in ${report.lane}`,
	);
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
	assert.equal(
		reports.length,
		Object.keys(requiredChecks).length,
		"Missing or duplicate lane reports",
	);
	assert.equal(
		new Set(reports.map((report) => report.lane)).size,
		reports.length,
		"Duplicate lane reports",
	);
	for (const report of reports) validateReport(report, sha);
	assert.equal(
		new Set(reports.map((report) => report.package.integrity)).size,
		1,
		"Package integrity differs across lanes",
	);
	return {
		commit: sha,
		integrity: reports[0].package.integrity,
		lanes: reports.map((report) => report.lane),
	};
}
