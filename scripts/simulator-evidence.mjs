import { withFinalizers } from "./verification-lifecycle.mjs";
import { checkSimulatorResults } from "./simulator-results.mjs";

export function runSimulatorSuite({
	execute,
	extract,
	save,
	diagnostics,
	required,
}) {
	let summary;
	let tests;
	let failed = true;
	withFinalizers(() => {
		withFinalizers(execute, [
			() => {
				summary = extract("summary");
				save("summary", summary);
			},
			() => {
				tests = extract("tests");
				save("tests", tests);
			},
		]);
		checkSimulatorResults(summary, tests, required);
		failed = false;
	}, [
		() => {
			if (failed) diagnostics();
		},
	]);
}
