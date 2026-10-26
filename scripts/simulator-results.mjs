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
	"UIKitControlTests/testPlainSheetSwipe()",
];

export function simulatorOptions(args, diagnostic) {
	if (!diagnostic)
		assert.equal(args.length, 0, "Unexpected simulator arguments");
	const switches = args.filter((arg) => arg.startsWith("--"));
	assert(
		switches.length <= 1 && switches.every((arg) => arg === "--dismissal-only"),
		"Unexpected simulator switch",
	);
	const positionals = args.filter((arg) => !arg.startsWith("--"));
	assert(positionals.length <= 2, "Unexpected simulator arguments");
	const [profile = "baseline", device = "iphone"] = positionals;
	assert(
		["baseline", "modern"].includes(profile),
		"Unexpected simulator profile",
	);
	assert(["iphone", "ipad"].includes(device), "Unexpected simulator device");
	return { profile, device, scope: switches.length ? "dismissal" : "all" };
}

export function simulatorSelection(diagnostic, scope = "all") {
	assert(["all", "dismissal"].includes(scope), "Unexpected simulator scope");
	assert(
		diagnostic || scope === "all",
		"Qualification requires all simulator cases",
	);
	const select = (cases) =>
		scope === "all"
			? [...cases]
			: cases.filter((id) => /\/test(?:Cancel|Swipe|PlainSheetSwipe)/.test(id));
	const control = select(controlCases);
	const chooser = select(simulatorCases);
	return { control, chooser };
}

export function simulatorTestArguments(required, scope) {
	if (scope === "all") return [];
	assert.equal(scope, "dismissal", "Unexpected simulator scope");
	return required.map(
		(id) => `-only-testing:${id.split("/")[0]}/${id.replace(/\(\)$/, "")}`,
	);
}

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
