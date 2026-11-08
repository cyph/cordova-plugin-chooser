import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

export const rc1 = Object.freeze({
	name: "cordova-plugin-chooser",
	version: "2.0.0-rc.1",
	url: "https://registry.npmjs.org/cordova-plugin-chooser/-/cordova-plugin-chooser-2.0.0-rc.1.tgz",
	integrity:
		"sha512-8NYV/y8xT2rnHvM3XuC/beFFBRhWgLfvjlln+0kai/FH+5pXm/6E497c4L0u7+BSc/h073WnyAw+woq5oDF4wg==",
});
export const comparisonBudgets = Object.freeze({
	prepareMinutes: 35,
	pluginArmMinutes: 50,
	controlArmMinutes: 45,
	evidenceMinutes: 15,
	jobMinutes: 340,
	workflowMinutes: 360,
	caseSeconds: 180,
});
export const comparisonDocuments = Object.freeze(
	[
		["JSON", "fixture-json.json"],
		["CSV", "fixture-csv.csv"],
		["PDF", "fixture-pdf.pdf"],
		["Image", "fixture-image.png"],
		["MP4", "fixture-mp4.mp4"],
		["MOV", "fixture-mov.mov"],
	].map(([format, name]) => Object.freeze({ format, name })),
);
export const comparisonPartitions = Object.freeze(
	["cordova-ios7", "cordova-ios8"].flatMap((framework) =>
		["iphone", "ipad"].map((device) => Object.freeze({ framework, device })),
	),
);
const pluginCases = [
	...comparisonDocuments.map(({ format }) => `ChooserUITests/test${format}()`),
	"ChooserUITests/testCancelPromiseReopen()",
];
const controlCases = ["Import", "Open"].flatMap((mode) =>
	["JSON", "CSV", "PDF"].map(
		(format) => `UIKitControlTests/test${mode}Original${format}()`,
	),
);
export const comparisonSetupCases = [
	"UIKitControlTests/testCancel()",
	...comparisonDocuments.map(
		({ format }) => `UIKitControlTests/testSeed${format}()`,
	),
];

export function comparisonIntegrity(bytes, expected) {
	const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (expected)
		assert.equal(actual, expected, "Comparison package integrity mismatch");
	return actual;
}

export function createComparisonPlan({
	framework,
	device,
	output,
	experiment,
}) {
	assert(
		comparisonPartitions.some(
			(p) => p.framework === framework && p.device === device,
		),
		"Unexpected comparison partition",
	);
	assert(
		experiment === undefined ||
			experiment === "releases" ||
			experiment === "metadata-mode" ||
			experiment === "metadata-regression" ||
			experiment === "metadata-restoration",
		"Unexpected comparison experiment",
	);
	const metadataVariants =
		experiment === "metadata-mode" || experiment === "metadata-restoration";
	const metadataTargets =
		experiment === "metadata-regression" ||
		experiment === "metadata-restoration";
	assert(
		!metadataTargets || device === "ipad",
		`Unexpected ${experiment} partition`,
	);
	const focusedMetadata = metadataVariants || metadataTargets;
	const targetFormat =
		metadataTargets && framework === "cordova-ios7" ? "PDF" : "Image";
	const documents = comparisonDocuments
		.filter(({ format }) => !focusedMetadata || format === targetFormat)
		.map((document) => ({ ...document }));
	const setup = focusedMetadata
		? [
				"UIKitControlTests/testCancel()",
				`UIKitControlTests/testSeed${targetFormat}()`,
			]
		: comparisonSetupCases;
	const releases = metadataVariants
		? ["uikit", "rc2-open", "rc2-import", "rc2-import", "rc2-open", "uikit"]
		: ["uikit", "rc1", "rc2", "rc2", "rc1", "uikit"];
	output = resolve(output);
	const packages = Object.fromEntries(
		(metadataVariants ? ["rc2-open", "rc2-import"] : ["rc1", "rc2"]).map(
			(release) => [
				release,
				{
					release,
					...(metadataVariants
						? {
								comparisonRelease: "rc2",
								metadataAsCopy: release === "rc2-import",
							}
						: {}),
					directory: join(output, "packages", release),
					generated: join(output, "packages", release, "app"),
					build: join(output, "packages", release, "build"),
					evidence: join(output, "packages", release, "evidence"),
				},
			],
		),
	);
	return {
		schema: 1,
		framework,
		device,
		output,
		...(focusedMetadata ? { experiment, documents } : {}),
		budgets: { ...comparisonBudgets },
		packages,
		arms: releases.map((release, index) => {
			const id = `${String(index + 1).padStart(2, "0")}-${release}`;
			let cases = release === "uikit" ? controlCases : pluginCases;
			if (focusedMetadata) {
				cases =
					release === "uikit"
						? ["Import", "Open"].map(
								(mode) =>
									`UIKitControlTests/test${mode}Original${targetFormat}()`,
							)
						: [`ChooserUITests/test${targetFormat}()`];
				// Reverse both the package order and the paired UIKit controls.
				if (index === 5) cases.reverse();
			}
			return {
				id,
				release,
				ordinal: index + 1,
				directory: join(output, "arms", id),
				minutes: release === "uikit" ? 45 : 50,
				setup: [...setup],
				cases: [...cases],
			};
		}),
	};
}

export function comparisonDeadline(now, milliseconds, ceiling) {
	return Math.min(now + milliseconds, ceiling);
}
export function comparisonTimeout(deadline, now = Date.now(), cap = Infinity) {
	const timeout = Math.floor(Math.min(deadline - now, cap));
	if (timeout <= 0)
		throw Object.assign(new Error("Comparison stage deadline exhausted"), {
			code: "ETIMEDOUT",
		});
	return timeout;
}
export function comparisonError(error) {
	return {
		message: String(error?.message ?? error),
		...(error?.code ? { code: error.code } : {}),
		...(error?.log ? { log: error.log } : {}),
		...(typeof error?.partialOutput === "boolean"
			? { partialOutput: error.partialOutput }
			: {}),
		...(Array.isArray(error?.errors)
			? { errors: error.errors.map(comparisonError) }
			: {}),
	};
}
export function comparisonTimedOut(error) {
	return error?.code === "ETIMEDOUT" || error?.status === 124;
}

export function checkComparisonResults(report, plan) {
	assert.deepEqual(report.plan, plan, "Comparison manifest changed");
	assert.equal(
		report.prepare.status,
		"passed",
		"Comparison preparation failed",
	);
	if (
		plan.experiment === "metadata-mode" ||
		plan.experiment === "metadata-regression" ||
		plan.experiment === "metadata-restoration"
	) {
		const descriptors = report.context?.descriptors ?? {};
		assert.deepEqual(
			Object.keys(descriptors).sort(),
			Object.keys(plan.packages).sort(),
			`Incorrect ${plan.experiment} descriptors`,
		);
		// Preparation verifies the archives and any exact patch. Bind its complete
		// descriptors to the planned release or variant.
		for (const [release, expected] of Object.entries(plan.packages))
			for (const [field, value] of Object.entries(expected))
				assert.deepEqual(
					descriptors[release][field],
					value,
					`Incorrect descriptor ${release}.${field}`,
				);
	}
	assert.deepEqual(
		report.arms.map((a) => a.id),
		plan.arms.map((a) => a.id),
		"Missing, duplicate or reordered arms",
	);
	const devices = report.arms.map((a) => a.udid);
	assert(
		devices.every(
			(id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
		),
		"Missing owned simulator",
	);
	assert.equal(
		new Set(devices).size,
		6,
		"Comparison reused a simulator/provider store",
	);
	for (const [index, arm] of report.arms.entries()) {
		if (
			plan.experiment === "metadata-mode" ||
			plan.experiment === "metadata-regression" ||
			plan.experiment === "metadata-restoration"
		)
			assert.equal(
				arm.release,
				plan.arms[index].release,
				`Incorrect arm release ${arm.id}`,
			);
		assert.equal(arm.status, "passed", `Unsuccessful arm ${arm.id}`);
		assert.equal(arm.evidence.status, "passed", `Missing evidence ${arm.id}`);
		for (const group of ["setup", "cases"]) {
			assert.deepEqual(
				arm[group].map((c) => c.id),
				plan.arms[index][group],
				`Incorrect ${group} manifest ${arm.id}`,
			);
			assert(
				arm[group].every((c) => c.status === "passed"),
				`Failed/missing ${group} ${arm.id}`,
			);
		}
	}
}

// All records exist before preparation starts, including on an early failure.
export async function runComparisonSchedule({
	plan,
	prepare,
	executeArm,
	collectArm,
	save = () => {},
	now = Date.now,
}) {
	const started = now();
	const end = started + comparisonBudgets.jobMinutes * 60_000;
	const report = {
		schema: 1,
		kind: "ios-release-comparison",
		status: "running",
		started,
		plan: structuredClone(plan),
		prepare: { status: "not-started" },
		arms: plan.arms.map((arm) => ({
			id: arm.id,
			...(plan.experiment === "metadata-mode" ||
			plan.experiment === "metadata-regression" ||
			plan.experiment === "metadata-restoration"
				? { release: arm.release }
				: {}),
			status: "not-started",
			setup: arm.setup.map((id) => ({ id, status: "not-started" })),
			cases: arm.cases.map((id) => ({ id, status: "not-started" })),
			evidence: { status: "not-started" },
		})),
		errors: [],
	};
	save(report);
	let ready = false;
	try {
		report.prepare = {
			status: "running",
			started: now(),
			deadline: comparisonDeadline(now(), 35 * 60_000, end),
		};
		save(report);
		report.context = await prepare({
			report,
			deadline: report.prepare.deadline,
		});
		comparisonTimeout(report.prepare.deadline, now());
		report.prepare.status = "passed";
		ready = true;
	} catch (error) {
		report.prepare.status = comparisonTimedOut(error) ? "timed-out" : "failed";
		report.errors.push(comparisonError(error));
	} finally {
		report.prepare.finished = now();
		save(report);
	}
	for (const [index, arm] of plan.arms.entries()) {
		const record = report.arms[index];
		if (!ready) {
			record.reason = "Shared preparation failed";
			save(report);
			continue;
		}
		record.started = now();
		record.deadline = comparisonDeadline(now(), arm.minutes * 60_000, end);
		record.status = "running";
		save(report);
		try {
			comparisonTimeout(record.deadline, now());
			await executeArm({
				arm,
				record,
				report,
				deadline: record.deadline,
				save: () => save(report),
			});
			comparisonTimeout(record.deadline, now());
			record.status = [...record.setup, ...record.cases].every(
				(c) => c.status === "passed",
			)
				? "passed"
				: "failed";
		} catch (error) {
			record.status = comparisonTimedOut(error) ? "timed-out" : "failed";
			record.error = comparisonError(error);
		} finally {
			record.finished = now();
			record.evidence = {
				status: "running",
				started: now(),
				deadline: comparisonDeadline(now(), 150_000, end),
			};
			save(report);
			try {
				await collectArm({
					arm,
					record,
					report,
					deadline: record.evidence.deadline,
				});
				comparisonTimeout(record.evidence.deadline, now());
				record.evidence.status = "passed";
			} catch (error) {
				record.evidence.status = comparisonTimedOut(error)
					? "timed-out"
					: "failed";
				record.evidence.error = comparisonError(error);
			}
			record.evidence.finished = now();
			save(report);
		}
	}
	try {
		checkComparisonResults(report, plan);
		report.status = "passed";
	} catch (error) {
		report.status = "failed";
		report.errors.push(comparisonError(error));
	}
	report.finished = now();
	save(report);
	return report;
}
