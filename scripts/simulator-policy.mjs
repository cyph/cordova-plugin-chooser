import assert from "node:assert/strict";
import { simulatorCaseRecords } from "./simulator-results.mjs";

const swipeCases = [
	"UIKitControlTests/testSwipe()",
	"UIKitControlTests/testSystemDelegateSwipe()",
];

export function nativeSwipePolicy({ tests, output, events }) {
	const records = simulatorCaseRecords(tests);
	for (const id of [...swipeCases, "UIKitControlTests/testPlainSheetSwipe()"]) {
		const matches = records.filter((record) => record.id === id);
		assert.equal(
			matches.length,
			1,
			`Missing or duplicate native control: ${id}`,
		);
		assert.equal(
			matches[0].result,
			"Passed",
			`Unsuccessful native control: ${id}`,
		);
	}
	const observations = output
		.split(/\r?\n/)
		.filter((line) => line.includes("CHOOSER_NATIVE_SWIPE "))
		.map((line) => {
			const value = JSON.parse(
				line.slice(
					line.indexOf("CHOOSER_NATIVE_SWIPE ") +
						"CHOOSER_NATIVE_SWIPE ".length,
				),
			);
			assert.deepEqual(Object.keys(value).sort(), ["case", "outcome"]);
			assert(
				swipeCases.includes(value.case),
				"Unexpected native swipe identity",
			);
			assert(
				["dismissed", "prevented"].includes(value.outcome),
				"Unknown native swipe outcome",
			);
			return value;
		});
	assert.equal(
		observations.length,
		swipeCases.length,
		"Missing or duplicate native swipe observation",
	);
	assert.deepEqual(
		observations.map((value) => value.case).sort(),
		[...swipeCases].sort(),
		"Missing or duplicate native swipe identity",
	);
	assert.equal(
		new Set(observations.map((value) => value.outcome)).size,
		1,
		"Native swipe controls disagree",
	);
	const outcome = observations[0].outcome;
	const evidence = events
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const observed = evidence.filter(
		(event) => event.case === "-[UIKitControlTests testSwipe]",
	);
	const owners = observed.flatMap((event) => {
		const match =
			/^UIKit original presentation delegate=(.+) replaced=false$/.exec(
				event.message,
			);
		return match ? [match[1]] : [];
	});
	assert.equal(owners.length, 1, "Missing preserved UIKit delegate evidence");
	const presentations = observed
		.filter((event) => event.message.startsWith("presented "))
		.map((event) => JSON.parse(event.message.slice("presented ".length)));
	assert.equal(presentations.length, 1, "Missing reference presentation");
	assert.equal(
		presentations[0].presentationDelegate,
		owners[0],
		"Reference changed UIKit delegate ownership",
	);
	for (const id of swipeCases) {
		const method = id.split("/")[1].replace(/\(\)$/, "");
		const messages = evidence
			.filter((event) => event.case === `-[UIKitControlTests ${method}]`)
			.map((event) => event.message);
		assert(
			messages.includes("UIKit cancellation delegate"),
			`Native swipe lacks its document-picker cancellation callback: ${id}`,
		);
		assert.deepEqual(
			messages.filter((message) => message.startsWith("UIKit delegate ")),
			["UIKit delegate canceled:1"],
			`Native swipe must complete once through its document-picker delegate: ${id}`,
		);
	}
	return {
		policy: outcome === "dismissed" ? "allowed" : "prevented",
		observations,
	};
}
