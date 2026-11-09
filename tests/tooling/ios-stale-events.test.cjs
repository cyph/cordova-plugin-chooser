const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const rawTests = require("./fixtures/xcresult/chooser-tests.json");
const rawSummary = require("./fixtures/xcresult/chooser-summary.json");
const api = import("../../scripts/ios-stale-events-model.mjs");
const root = join(__dirname, "../..");
const swiftPath = "src/ios/Chooser.swift";
const expected = [
	{
		id: "photos",
		test: "ChooserPickerTests/testPhotoPickerConfigurationAndCancellation()",
		deleted: "presentation?.controller === controller, ",
	},
	{
		id: "adaptive",
		test: "ChooserPickerTests/testAdaptiveDismissalAndStaleCallbacks()",
		deleted:
			"presentationController.presentedViewController === presentation?.controller, ",
	},
	{
		id: "request-id",
		test: "ChooserPickerTests/testSignalCancellationIdentityAndImmediateReopen()",
		deleted: ", request.id == id",
	},
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const marker = (id) => `CHOOSER_STALE_EVENT:${id}`;
const message = (id) =>
	`ChooserPickerTests.swift:42: XCTAssertTrue failed - ${marker(id)}`;

function sourceCopy(t, source = readFileSync(join(root, swiftPath), "utf8")) {
	const directory = mkdtempSync(join(tmpdir(), "chooser-stale-events-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "src/ios"), { recursive: true });
	const path = join(directory, swiftPath);
	writeFileSync(path, source);
	return { directory, path };
}

// Representative raw failure from metadata-restoration's case-01-testImage
// summary. Keep the numeric opaque ID, string ID, URL and bare method name.
function summaryFailure(id) {
	const { test: identity } = expected.find((value) => value.id === id);
	const [suite, method] = identity.split("/");
	return {
		failureText: message(id),
		targetName: suite,
		testIdentifier: 1,
		testIdentifierString: identity,
		testIdentifierURL: `test://com.apple.xcode/ChooserSimulator/${suite}/${suite}/${method.slice(0, -2)}`,
		testName: method,
	};
}

function fixture(id = "baseline") {
	const baseline = id === "baseline";
	const result = baseline ? "Passed" : "Failed";
	const selected = baseline
		? expected
		: expected.filter((value) => value.id === id);
	const tests = structuredClone(rawTests);
	const plan = tests.testNodes[0];
	const bundle = plan.children[0];
	const suite = bundle.children[0];
	const template = suite.children[0];
	plan.children = [
		bundle,
		{ nodeType: "Runtime Warning", name: "Diagnostic warning" },
	];
	for (const node of [plan, bundle, suite]) node.result = result;
	suite.children = selected.map(({ test: identity }) => ({
		...structuredClone(template),
		name: identity.split("/")[1],
		nodeIdentifier: identity,
		result,
		...(!baseline && {
			children: [{ nodeType: "Failure Message", name: message(id) }],
		}),
	}));
	return {
		id,
		command: { status: baseline ? 0 : 65, signal: null },
		summary: {
			...structuredClone(rawSummary),
			result,
			totalTestCount: selected.length,
			passedTests: baseline ? selected.length : 0,
			failedTests: baseline ? 0 : 1,
			testFailures: baseline ? [] : [summaryFailure(id)],
		},
		tests,
	};
}

const cases = (value) =>
	value.tests.testNodes[0].children[0].children[0].children;
const failures = (value) => cases(value)[0].children;

test("mutation descriptors delete precisely the three production identity guards", async () => {
	const { staleEventMutations } = await api;
	assert.deepEqual(
		staleEventMutations.map(({ id }) => id),
		expected.map(({ id }) => id),
	);
	for (const [index, mutation] of staleEventMutations.entries()) {
		const wanted = expected[index];
		assert.deepEqual(
			Object.keys(mutation).sort(),
			["id", "test", "marker", "original", "replacement"].sort(),
		);
		assert.equal(mutation.test, wanted.test);
		assert.equal(mutation.marker, marker(wanted.id));
		assert.equal(mutation.original.split(wanted.deleted).length - 1, 1);
		assert.equal(
			mutation.replacement,
			mutation.original.replace(wanted.deleted, ""),
		);
		assert.match(
			mutation.original,
			/^(?:guard .* else \{ return \}|if let request .* \{)$/,
		);
	}
});

test("mutations edit only isolated Swift copies and report hashes of exact bytes", async (t) => {
	const { staleEventMutations, applyStaleEventMutation } = await api;
	const canonical = readFileSync(join(root, swiftPath));
	for (const [index, mutation] of staleEventMutations.entries()) {
		const { directory, path } = sourceCopy(t, canonical);
		const sentinel = join(directory, "src/ios/untouched.txt");
		writeFileSync(sentinel, "unchanged");
		const patch = applyStaleEventMutation(directory, mutation.id);
		const after = readFileSync(path);
		assert.deepEqual(patch, {
			path: swiftPath,
			original: mutation.original,
			replacement: mutation.replacement,
			beforeSha256: sha256(canonical),
			afterSha256: sha256(after),
		});
		assert.equal(
			after.toString(),
			canonical.toString().replace(expected[index].deleted, ""),
		);
		assert.notEqual(patch.beforeSha256, patch.afterSha256);
		assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
		assert.deepEqual(readFileSync(join(root, swiftPath)), canonical);
		assert.throws(
			() => applyStaleEventMutation(directory, mutation.id),
			/exactly one known original/,
		);
		assert.deepEqual(readFileSync(path), after);
	}
});

test("mutation application rejects missing, duplicate and drifted guards without writes", async (t) => {
	const { staleEventMutations, applyStaleEventMutation } = await api;
	const source = readFileSync(join(root, swiftPath), "utf8");
	const { directory, path } = sourceCopy(t);
	for (const mutation of staleEventMutations) {
		for (const invalid of [
			"unexpected source",
			source.replace(mutation.original, mutation.replacement),
			source.replace(
				mutation.original,
				mutation.original.replace(" = ", "  = "),
			),
			`${source}\n${mutation.original}`,
		]) {
			writeFileSync(path, invalid);
			assert.throws(
				() => applyStaleEventMutation(directory, mutation.id),
				/exactly one known original/,
			);
			assert.equal(readFileSync(path, "utf8"), invalid);
		}
	}
	writeFileSync(path, source);
	for (const id of ["baseline", "unknown", "Photos", undefined]) {
		assert.throws(
			() => applyStaleEventMutation(directory, id),
			/Unknown stale-event mutation/,
		);
		assert.equal(readFileSync(path, "utf8"), source);
	}
	assert.throws(() => applyStaleEventMutation(root, "photos"), /isolated copy/);
	assert.equal(readFileSync(join(root, swiftPath), "utf8"), source);
});

test("baseline requires all three exact passing cases and accepts raw warning nodes", async () => {
	const { checkStaleEventResults } = await api;
	const value = fixture();
	const before = structuredClone(value);
	assert.equal(checkStaleEventResults(value), undefined);
	assert.deepEqual(value, before);
	delete value.summary.result;
	delete value.summary.expectedFailures;
	delete value.summary.testFailures;
	delete value.command.signal;
	checkStaleEventResults(value);
});

test("each mutant requires its exact failed case and marked assertions in raw tree and summary", async () => {
	const { checkStaleEventResults } = await api;
	for (const { id } of expected) {
		const value = fixture(id);
		const before = structuredClone(value);
		checkStaleEventResults(value);
		assert.deepEqual(value, before);
		failures(value).push({ nodeType: "Failure Message", details: message(id) });
		value.summary.testFailures.push(summaryFailure(id));
		checkStaleEventResults(value);
		delete value.summary.testFailures;
		delete value.summary.result;
		delete value.summary.expectedFailures;
		checkStaleEventResults(value);
		for (const remove of [
			["testIdentifier", "testIdentifierString", "testIdentifierURL"],
			["testName", "testIdentifierURL", "targetName"],
		]) {
			const raw = fixture(id);
			for (const key of remove) delete raw.summary.testFailures[0][key];
			checkStaleEventResults(raw);
		}
		const qualified = fixture(id);
		qualified.summary.testFailures = [
			{
				failureText: message(id),
				testName: expected
					.find((item) => item.id === id)
					.test.replace("/", "."),
			},
		];
		checkStaleEventResults(qualified);
	}
});

test("command status, signals and exceptions cannot qualify baseline or mutant evidence", async () => {
	const { checkStaleEventResults } = await api;
	for (const id of ["baseline", ...expected.map(({ id }) => id)]) {
		for (const command of [
			undefined,
			{},
			{ status: id === "baseline" ? 65 : 0 },
			{ status: 1 },
			{ status: 70 },
			{ status: null, signal: "SIGTERM" },
			{ status: id === "baseline" ? 0 : 65, signal: "SIGKILL" },
			{ status: id === "baseline" ? 0 : 65, error: { code: "ETIMEDOUT" } },
			{ status: id === "baseline" ? 0 : 65, error: new Error("spawn failed") },
		])
			assert.throws(
				() => checkStaleEventResults({ ...fixture(id), command }),
				`${id}: ${JSON.stringify(command)}`,
			);
	}
});

test("baseline rejects missing, duplicate, unexpected and unsuccessful cases", async () => {
	const { checkStaleEventResults } = await api;
	const edits = [
		(value) => {
			cases(value).pop();
			value.summary.totalTestCount--;
			value.summary.passedTests--;
		},
		(value) => {
			cases(value).push(structuredClone(cases(value)[0]));
			value.summary.totalTestCount++;
			value.summary.passedTests++;
		},
		(value) => {
			cases(value)[0].nodeIdentifier = "OtherTests/testUnexpected()";
		},
		(value) => {
			cases(value)[0].result = "Skipped";
		},
		(value) => {
			cases(value)[0].result = "Failed";
		},
		(value) => {
			cases(value)[0].result = "Expected Failure";
		},
		(value) => {
			cases(value)[0].children = [
				{ nodeType: "Failure Message", name: message("photos") },
			];
		},
		(value) => {
			value.summary.result = "Failed";
		},
		(value) => {
			value.summary.testFailures = [summaryFailure("photos")];
		},
		(value) => {
			value.tests.testNodes.push({
				nodeType: "Failure Message",
				name: "Build failed",
			});
		},
	];
	for (const edit of edits) {
		const value = fixture();
		edit(value);
		assert.throws(() => checkStaleEventResults(value), edit.toString());
	}
});

test("mutants reject survival, missing results, duplicate or unexpected cases and mixed failures", async () => {
	const { checkStaleEventResults } = await api;
	const edits = [
		(value) => {
			cases(value)[0].result = "Passed";
		},
		(value) => {
			cases(value)[0].result = "Skipped";
		},
		(value) => {
			cases(value)[0].result = "Expected Failure";
		},
		(value) => {
			delete cases(value)[0].result;
		},
		(value) => {
			cases(value).pop();
		},
		(value) => {
			cases(value).push(structuredClone(cases(value)[0]));
		},
		(value) => {
			cases(value).push({
				nodeType: "Test Case",
				nodeIdentifier: "OtherTests/testUnexpected()",
				result: "Passed",
			});
		},
		(value) => {
			cases(value)[0].nodeIdentifier = "OtherTests/testUnexpected()";
		},
		(value) => {
			cases(value)[0].children = [];
		},
		(value) => {
			failures(value)[0].name = "XCTAssertTrue failed - unrelated assertion";
		},
		(value) => {
			failures(value)[0].name = marker("unknown");
		},
		(value) => {
			failures(value)[0].name = marker(value.id) + "-suffix";
		},
		(value) => {
			failures(value)[0].name += " " + marker("unknown");
		},
		(value) => {
			failures(value).push({
				nodeType: "Failure Message",
				name: "XCTUnwrap failed",
			});
		},
		(value) => {
			failures(value)[0].name += " Asynchronous wait failed: exceeded timeout";
		},
		(value) => {
			failures(value)[0].name += " Build failed";
		},
		(value) => {
			value.tests.testNodes.push({
				nodeType: "Failure Message",
				name: message(value.id),
			});
		},
		(value) => {
			failures(value).push(structuredClone(cases(value)[0]));
		},
		(value) => {
			failures(value).push({
				nodeType: "Group",
				children: [{ nodeType: "Failure Message", name: message(value.id) }],
			});
		},
		(value) => {
			value.tests.testNodes.push({
				nodeType: "Test Suite",
				result: "Failed",
				children: [],
			});
		},
	];
	for (const { id } of expected)
		for (const edit of edits) {
			const value = fixture(id);
			edit(value);
			assert.throws(() => checkStaleEventResults(value), `${id}: ${edit}`);
		}
});

test("summary failures cannot conceal unrelated cases, global errors or contradictory raw identities", async () => {
	const { checkStaleEventResults } = await api;
	for (const { id } of expected) {
		for (const patch of [
			{ failureText: "Unrelated assertion" },
			{ failureText: marker("unknown") },
			{ testIdentifierString: "OtherTests/testUnexpected()" },
			{ testIdentifier: "OtherTests/testUnexpected()" },
			{ testIdentifier: null },
			{ testName: "testUnexpected()" },
			{ targetName: "OtherTests" },
			{
				testIdentifierURL:
					"test://com.apple.xcode/ChooserSimulator/OtherTests/OtherTests/testUnexpected",
			},
		]) {
			const value = fixture(id);
			Object.assign(value.summary.testFailures[0], patch);
			assert.throws(() => checkStaleEventResults(value), JSON.stringify(patch));
		}
		for (const extra of [
			{ failureText: message(id) },
			{ ...summaryFailure(id), failureText: "Global compile failure" },
			{
				...summaryFailure(id),
				testIdentifierString: "OtherTests/testUnexpected()",
			},
		]) {
			const value = fixture(id);
			value.summary.testFailures.push(extra);
			assert.throws(() => checkStaleEventResults(value));
		}
		for (const list of [
			[],
			null,
			"failed",
			[{ failureText: message(id), testIdentifier: 1 }],
		]) {
			const value = fixture(id);
			value.summary.testFailures = list;
			assert.throws(() => checkStaleEventResults(value));
		}
	}
});

test("all modes reject inconsistent counters and malformed or absent xcresult data", async () => {
	const { checkStaleEventResults } = await api;
	for (const id of ["baseline", ...expected.map(({ id }) => id)]) {
		for (const key of [
			"totalTestCount",
			"passedTests",
			"failedTests",
			"skippedTests",
			"expectedFailures",
		]) {
			const value = fixture(id);
			value.summary[key]++;
			assert.throws(() => checkStaleEventResults(value), `${id}: ${key}`);
			value.summary[key] = String(value.summary[key] - 1);
			assert.throws(
				() => checkStaleEventResults(value),
				`${id}: string ${key}`,
			);
		}
		for (const tests of [
			undefined,
			{},
			{ testNodes: [] },
			{ testNodes: null },
			{ testNodes: [null] },
			{ testNodes: [{ children: "bad" }] },
		])
			assert.throws(() => checkStaleEventResults({ ...fixture(id), tests }));
		for (const summary of [undefined, null, {}])
			assert.throws(() => checkStaleEventResults({ ...fixture(id), summary }));
	}
	for (const id of ["unknown", "Photos", undefined])
		assert.throws(
			() => checkStaleEventResults({ ...fixture(), id }),
			/Unknown stale-event mutation/,
		);
});
