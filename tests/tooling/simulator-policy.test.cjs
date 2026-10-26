const test = require("node:test");
const assert = require("node:assert/strict");

test("native swipe references require successful independent controls and matching observed transitions", async () => {
	const { nativeSwipePolicy } =
		await import("../../scripts/simulator-policy.mjs");
	function fixture(outcome) {
		return {
			tests: {
				testNodes: [
					"testSwipe",
					"testSystemDelegateSwipe",
					"testPlainSheetSwipe",
				].map((name) => ({
					nodeType: "Test Case",
					nodeIdentifier: `UIKitControlTests/${name}()`,
					result: "Passed",
				})),
			},
			output: ["testSwipe", "testSystemDelegateSwipe"]
				.map(
					(name) =>
						`CHOOSER_NATIVE_SWIPE ${JSON.stringify({ case: `UIKitControlTests/${name}()`, outcome })}`,
				)
				.join("\n"),
			events: JSON.stringify({
				case: "-[UIKitControlTests testSwipe]",
				message:
					outcome === "prevented"
						? "UIKit adaptive dismissal attempt was prevented: policy"
						: "UIKit adaptive dismissal delegate",
			}),
		};
	}
	for (const outcome of ["dismissed", "prevented"]) {
		assert.equal(
			nativeSwipePolicy(fixture(outcome)).policy,
			outcome === "dismissed" ? "allowed" : "prevented",
		);
	}
	for (const change of [
		(value) => {
			value.tests.testNodes.pop();
		},
		(value) => {
			value.tests.testNodes[0].result = "Failed";
		},
		(value) => {
			value.tests.testNodes[1].result = "Skipped";
		},
		(value) => {
			value.tests.testNodes.push(value.tests.testNodes[0]);
		},
		(value) => {
			value.output = "";
		},
		(value) => {
			value.output += "\n" + value.output;
		},
		(value) => {
			value.output = value.output.replace(
				"testSystemDelegateSwipe",
				"testSwipe",
			);
		},
		(value) => {
			value.output = value.output.replace(
				'"outcome":"prevented"',
				'"outcome":"dismissed"',
			);
		},
		(value) => {
			value.output = value.output.replace("prevented", "unknown");
		},
		(value) => {
			value.output = "CHOOSER_NATIVE_SWIPE invalid";
		},
		(value) => {
			value.events = "";
		},
		(value) => {
			value.events = value.events.replace("testSwipe", "testCancel");
		},
	]) {
		const value = fixture("prevented");
		change(value);
		assert.throws(() => nativeSwipePolicy(value));
	}
});
