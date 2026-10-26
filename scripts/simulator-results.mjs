import assert from "node:assert/strict";

const formats = ["JSON", "CSV", "PDF", "Image", "MP4", "MOV"];
export const simulatorCases = [
	...[
		"testAdaptiveDismissalAndStaleCallbacks",
		"testResetAndDuplicateSelectionCannotSettleANewerRequest",
		"testMovieWildcardIncludesMP4AndQuickTime",
	].map((name) => `ChooserPickerTests/${name}()`),
	...formats.map((name) => `ChooserUITests/test${name}()`),
	...[
		"testCancelPromiseReopen",
		"testCancelCallbackReopen",
		"testSwipePromiseReopen",
		"testSwipeCallbackReopen",
	].map((name) => `ChooserUITests/${name}()`),
];
export const controlCases = [
	...formats.map((name) => `UIKitControlTests/test${name}()`),
	"UIKitControlTests/testCancel()",
	"UIKitControlTests/testSwipe()",
];

export function simulatorCaseRecords(tests) {
	assert(Array.isArray(tests?.testNodes), "Missing simulator test tree");
	const records = [];
	function visit(nodes) {
		for (const node of nodes) {
			assert(node && typeof node === "object", "Malformed simulator node");
			if (node.nodeType === "Test Case") {
				assert.equal(
					typeof node.nodeIdentifier,
					"string",
					"Missing test identity",
				);
				records.push({
					id: node.nodeIdentifier,
					result: node.result,
					failures: (node.children ?? [])
						.filter((child) => child.nodeType === "Failure Message")
						.map(
							(child) => child.name ?? child.details ?? "Unspecified failure",
						),
				});
			} else if (node.children !== undefined) {
				assert(Array.isArray(node.children), "Malformed simulator children");
				visit(node.children);
			}
		}
	}
	visit(tests.testNodes);
	return records;
}

export function checkSimulatorResults(
	summary,
	tests,
	required = simulatorCases,
) {
	const records = simulatorCaseRecords(tests);
	for (const record of records)
		assert.equal(record.result, "Passed", `Unsuccessful case: ${record.id}`);
	const cases = records.map((record) => record.id);
	assert.equal(new Set(cases).size, cases.length, "Duplicate simulator case");
	assert.deepEqual(
		[...cases].sort(),
		[...required].sort(),
		"Missing or unexpected simulator case",
	);
	assert.equal(
		summary.totalTestCount,
		cases.length,
		"Inconsistent simulator total",
	);
	assert.equal(
		summary.passedTests,
		cases.length,
		"Unsuccessful simulator tests",
	);
	assert.equal(summary.skippedTests, 0, "Simulator tests were skipped");
	assert.equal(summary.failedTests, 0, "Simulator tests failed");
}
