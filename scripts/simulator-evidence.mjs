import { withFinalizers } from "./verification-lifecycle.mjs";
import { checkSimulatorResults } from "./simulator-results.mjs";

export function runSimulatorSuite({
	execute,
	extract,
	save,
	diagnostics,
	required,
	resultsAvailable = () => true,
	missingResults = () => {},
}) {
	let summary;
	let tests;
	let available;
	let failed = true;
	withFinalizers(() => {
		withFinalizers(execute, [
			() => {
				available = resultsAvailable();
				if (!available) {
					missingResults();
					return;
				}
				summary = extract("summary");
				save("summary", summary);
			},
			() => {
				if (!available) return;
				tests = extract("tests");
				save("tests", tests);
			},
		]);
		if (!available)
			throw new Error(
				"Simulator tests did not start: no result bundle was produced",
			);
		checkSimulatorResults(summary, tests, required);
		failed = false;
	}, [
		() => {
			if (failed) diagnostics();
		},
	]);
}
