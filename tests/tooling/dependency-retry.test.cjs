const test = require("node:test");
const assert = require("node:assert/strict");

test("only transient dependency preparation failures are retried with bounded backoff", async () => {
	const { retryDependencyPreparation } =
		await import("../../scripts/dependency-retry.mjs");
	let attempts = 0,
		elapsed = 0;
	const delays = [];
	const error = Object.assign(new Error("download"), {
		commandOutput: "Could not GET artifact. Received status code 429",
	});
	assert.equal(
		retryDependencyPreparation(
			(budget) => {
				assert(budget <= 1200000);
				if (++attempts < 3) throw error;
				return "ready";
			},
			{
				now: () => elapsed,
				wait: (delay) => {
					delays.push(delay);
					elapsed += delay;
				},
			},
		),
		"ready",
	);
	assert.deepEqual(delays, [15000, 45000]);
	for (const output of [
		"checksum mismatch HTTP 503",
		"Dependency verification failed HTTP 429",
		"dependency lock state failed HTTP 502",
		"test failed HTTP 429",
		"unknown build failure",
	]) {
		let count = 0;
		assert.throws(() =>
			retryDependencyPreparation(
				() => {
					count++;
					throw Object.assign(new Error("permanent"), {
						commandOutput: output,
					});
				},
				{ wait: () => assert.fail("must not retry") },
			),
		);
		assert.equal(count, 1);
	}
	attempts = 0;
	assert.throws(() =>
		retryDependencyPreparation(
			() => {
				attempts++;
				throw error;
			},
			{
				now: () => 0,
				budgetMs: 10000,
				wait: () => assert.fail("budget exceeded"),
			},
		),
	);
	assert.equal(attempts, 1);
});
