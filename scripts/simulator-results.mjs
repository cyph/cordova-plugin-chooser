import assert from "node:assert/strict";

export const simulatorCases = [
	"testAdaptiveDismissalAndStaleCallbacks",
	"testResetAndDuplicateSelectionCannotSettleANewerRequest",
	"testMovieWildcardIncludesMP4AndQuickTime",
	"testCancelAndImmediateReopen",
	"testSwipeSheetSettlesOnceAndReopens",
	"testLocalFilesAndVideoWildcard",
];

export function checkSimulatorResults(summary, tests) {
	assert(
		Number.isSafeInteger(summary.totalTestCount) &&
			summary.totalTestCount >= simulatorCases.length,
		"Missing simulator tests",
	);
	assert.equal(
		summary.passedTests,
		summary.totalTestCount,
		"Unsuccessful simulator tests",
	);
	assert.equal(summary.skippedTests, 0, "Simulator tests were skipped");
	assert.equal(summary.failedTests, 0, "Simulator tests failed");
	const tree = JSON.stringify(tests);
	for (const name of simulatorCases)
		assert(tree.includes(name), `Missing simulator case: ${name}`);
}
