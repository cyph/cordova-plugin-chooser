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
			events: [
				...[
					"UIKit original presentation delegate=UIDocumentPickerViewController replaced=false",
					`presented ${JSON.stringify({ presentationDelegate: "UIDocumentPickerViewController" })}`,
				].map((message) => ({
					case: "-[UIKitControlTests testSwipe]",
					message,
				})),
				...["testSwipe", "testSystemDelegateSwipe"].flatMap((name) =>
					["UIKit cancellation delegate", "UIKit delegate canceled:1"].map(
						(message) => ({ case: `-[UIKitControlTests ${name}]`, message }),
					),
				),
			]
				.map((event) => JSON.stringify(event))
				.join("\n"),
		};
	}
	for (const outcome of ["dismissed", "prevented"]) {
		assert.equal(
			nativeSwipePolicy(fixture(outcome)).policy,
			outcome === "dismissed" ? "allowed" : "prevented",
		);
		const noDelegate = fixture(outcome);
		noDelegate.events = noDelegate.events.replaceAll(
			"UIDocumentPickerViewController",
			"nil",
		);
		assert.equal(
			nativeSwipePolicy(noDelegate).policy,
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
		(value) => {
			value.events = value.events.replace("replaced=false", "replaced=true");
		},
		(value) => {
			value.events = value.events.replace(
				"delegate=UIDocumentPickerViewController",
				"delegate=nil",
			);
		},
		(value) => {
			const events = value.events.split("\n").map((line) => JSON.parse(line));
			events.find((event) => event.message.startsWith("presented ")).message =
				`presented ${JSON.stringify({ presentationDelegate: "OtherDelegate" })}`;
			value.events = events.map((event) => JSON.stringify(event)).join("\n");
		},
		(value) => {
			value.events = value.events
				.split("\n")
				.filter((line) => !line.includes("testSystemDelegateSwipe"))
				.join("\n");
		},
		(value) => {
			value.events += "\n" + value.events.split("\n").at(-1);
		},
		(value) => {
			value.events = value.events
				.split("\n")
				.filter((line) => !line.includes("UIKit cancellation delegate"))
				.join("\n");
		},
		(value) => {
			value.events = value.events.replace(
				"UIKit delegate canceled:1",
				"UIKit delegate selected:fixture-csv.csv",
			);
		},
	]) {
		const value = fixture("prevented");
		change(value);
		assert.throws(() => nativeSwipePolicy(value));
	}
});
