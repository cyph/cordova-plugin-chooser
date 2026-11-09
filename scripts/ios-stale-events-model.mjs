import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkSimulatorResults,
	simulatorCaseRecords,
} from "./simulator-results.mjs";

const swiftPath = "src/ios/Chooser.swift";
const canonicalPath = fileURLToPath(
	new URL(`../${swiftPath}`, import.meta.url),
);

export const staleEventMutations = Object.freeze(
	[
		{
			id: "photos",
			test: "ChooserPickerTests/testPhotoPickerConfigurationAndCancellation()",
			original:
				"guard presentation?.controller === controller, let request = active, request.process() else { return }",
			replacement:
				"guard let request = active, request.process() else { return }",
		},
		{
			id: "adaptive",
			test: "ChooserPickerTests/testAdaptiveDismissalAndStaleCallbacks()",
			original:
				"guard presentationController.presentedViewController === presentation?.controller, let request = active, request.state == .selecting else { return }",
			replacement:
				"guard let request = active, request.state == .selecting else { return }",
		},
		{
			id: "request-id",
			test: "ChooserPickerTests/testSignalCancellationIdentityAndImmediateReopen()",
			original: "if let request = plugin.active, request.id == id {",
			replacement: "if let request = plugin.active {",
		},
	].map((mutation) =>
		Object.freeze({
			...mutation,
			marker: `CHOOSER_STALE_EVENT:${mutation.id}`,
		}),
	),
);

function mutationFor(id) {
	const mutation = staleEventMutations.find((value) => value.id === id);
	assert(mutation, `Unknown stale-event mutation: ${id}`);
	return mutation;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The runner supplies an isolated source copy; refuse aliases and shared files
// that could turn the experiment into an edit of the canonical package.
export function applyStaleEventMutation(directory, id) {
	const { original, replacement } = mutationFor(id);
	const path = join(realpathSync(directory), swiftPath);
	assert.equal(
		realpathSync(path),
		path,
		"Mutation source must be an isolated copy",
	);
	const source = statSync(path);
	const canonical = statSync(canonicalPath);
	assert(
		source.isFile() &&
			source.nlink === 1 &&
			!(source.dev === canonical.dev && source.ino === canonical.ino),
		"Mutation source must be an isolated copy, not canonical source",
	);
	const before = readFileSync(path);
	const text = before.toString("utf8");
	assert.equal(
		text.split(original).length - 1,
		1,
		`Expected exactly one known original stale-event guard: ${id}`,
	);
	const after = Buffer.from(text.replace(original, replacement), "utf8");
	writeFileSync(path, after);
	return {
		path: swiftPath,
		original,
		replacement,
		beforeSha256: sha256(before),
		afterSha256: sha256(after),
	};
}

function checkFailure(message, mutation) {
	assert(
		typeof message === "string" && message.trim().length > 0,
		"Missing stale-event failure message",
	);
	const markers = message.match(/CHOOSER_STALE_EVENT:[\w-]+/g) ?? [];
	assert(
		markers.length > 0 &&
			markers.every((marker) => marker === mutation.marker) &&
			markers.length === message.split("CHOOSER_STALE_EVENT:").length - 1,
		"Unrelated failure or wrong stale-event marker",
	);
	assert(
		!/\b(?:timed?\s*out|timeout|crash(?:ed)?|signal\s+\d+|compil(?:ation|e|er)\s+(?:failed|error)|build\s+failed|testing\s+cancel(?:led|ed))\b/i.test(
			message,
		),
		"Infrastructure failure is not a stale-event assertion",
	);
}

// simulatorCaseRecords intentionally extracts only immediate Failure Message
// children. Validate the whole raw xcresult tree first so global failures or
// nested/repeated cases cannot disappear during that extraction.
function checkTree(tests, mutation) {
	assert(Array.isArray(tests?.testNodes), "Missing simulator test tree");
	function visit(nodes, parentType, owner) {
		assert(Array.isArray(nodes), "Malformed simulator children");
		return nodes.flatMap((node) => {
			assert(
				node && !Array.isArray(node) && typeof node.nodeType === "string",
				"Malformed simulator node",
			);
			if (node.nodeType === "Failure Message") {
				assert(
					mutation && parentType === "Test Case" && owner === mutation.test,
					"Unexpected or global simulator failure",
				);
				checkFailure(node.name ?? node.details, mutation);
			}
			const isCase = node.nodeType === "Test Case";
			if (isCase) assert.equal(owner, undefined, "Nested simulator case");
			const descendants = visit(
				node.children ?? [],
				node.nodeType,
				isCase ? node.nodeIdentifier : owner,
			);
			if (isCase) return [node.result];
			if (node.result !== undefined) {
				assert(
					descendants.length > 0 || node.result === "Passed",
					"Unexpected global simulator result",
				);
				assert.equal(
					node.result,
					descendants.includes("Failed") ? "Failed" : "Passed",
					"Inconsistent simulator tree result",
				);
			}
			return descendants;
		});
	}
	visit(tests.testNodes);
}

function checkSummaryFailures(summary, mutation) {
	// testFailures is xcresult's summary field. Treat an explicitly supplied
	// failures list with the same strictness rather than silently ignoring it.
	for (const field of ["testFailures", "failures"]) {
		if (!(field in summary)) continue;
		const failures = summary[field];
		assert(Array.isArray(failures), "Malformed simulator summary failures");
		if (!mutation) {
			assert.equal(failures.length, 0, "Unexpected baseline summary failure");
			continue;
		}
		assert(failures.length > 0, "Missing mutant summary failure");
		const [suite, method] = mutation.test.split("/");
		const identities = [mutation.test, `${suite}.${method}`];
		for (const failure of failures) {
			assert(
				failure && typeof failure === "object",
				"Malformed summary failure",
			);
			// Raw xcresult summaries use a numeric, opaque testIdentifier;
			// testIdentifierString carries the actual case identity.
			const textualIds = [];
			if ("testIdentifierString" in failure)
				textualIds.push(failure.testIdentifierString);
			if ("testIdentifier" in failure) {
				if (typeof failure.testIdentifier === "string")
					textualIds.push(failure.testIdentifier);
				else
					assert(
						Number.isSafeInteger(failure.testIdentifier) &&
							failure.testIdentifier >= 0,
						"Malformed opaque summary failure identity",
					);
			}
			for (const identity of textualIds)
				assert(
					identities.includes(identity),
					"Unexpected summary failure identity",
				);
			if (failure.testName !== undefined)
				assert(
					identities.includes(failure.testName) || failure.testName === method,
					"Unexpected summary failure name",
				);
			if (failure.targetName !== undefined)
				assert.equal(
					failure.targetName,
					suite,
					"Unexpected summary failure target",
				);
			if ("testIdentifierURL" in failure) {
				assert.equal(
					typeof failure.testIdentifierURL,
					"string",
					"Malformed summary failure URL",
				);
				const url = new URL(failure.testIdentifierURL);
				assert.equal(url.protocol, "test:", "Unexpected summary failure URL");
				assert.deepEqual(
					url.pathname
						.split("/")
						.filter(Boolean)
						.map(decodeURIComponent)
						.slice(-3),
					[suite, suite, method.slice(0, -2)],
					"Unexpected summary failure URL identity",
				);
			}
			assert(
				textualIds.length > 0 ||
					identities.includes(failure.testName) ||
					(failure.targetName === suite && failure.testName === method) ||
					"testIdentifierURL" in failure,
				"Unrelated or global summary failure",
			);
			checkFailure(failure.failureText, mutation);
		}
	}
}

// Validation only: no native commands, baseline mutations, or runner policy.
// A successful mutant run means one intended assertion failure, not survival.
export function checkStaleEventResults({ id, summary, tests, command }) {
	const mutation = id === "baseline" ? undefined : mutationFor(id);
	assert(command && typeof command === "object", "Missing simulator command");
	assert.equal(
		command.status,
		mutation ? 65 : 0,
		"Unexpected simulator command status",
	);
	assert(command.signal == null, "Simulator command received a signal");
	assert(command.error == null, "Simulator command failed or timed out");
	assert(summary && typeof summary === "object", "Missing simulator summary");
	if ("result" in summary)
		assert.equal(
			summary.result,
			mutation ? "Failed" : "Passed",
			"Unexpected simulator summary result",
		);
	checkTree(tests, mutation);
	checkSummaryFailures(summary, mutation);
	if (!mutation)
		return checkSimulatorResults(
			summary,
			tests,
			staleEventMutations.map(({ test }) => test),
		);
	const records = simulatorCaseRecords(tests);
	assert.equal(records.length, 1, "Expected exactly one mutant simulator case");
	const [record] = records;
	assert.equal(record.id, mutation.test, "Unexpected mutant simulator case");
	assert.equal(
		record.result,
		"Failed",
		"Stale-event mutation survived or did not fail",
	);
	for (const [key, expected] of Object.entries({
		totalTestCount: 1,
		failedTests: 1,
		passedTests: 0,
		skippedTests: 0,
	}))
		assert.equal(summary[key], expected, `Inconsistent simulator ${key}`);
	assert.equal(
		summary.expectedFailures ?? 0,
		0,
		"Simulator tests had expected failures",
	);
	assert(record.failures.length > 0, "Missing mutant assertion failure");
	for (const failure of record.failures) checkFailure(failure, mutation);
}
