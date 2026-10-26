const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

test("failed simulator commands still export both result trees and diagnostics", async () => {
	const { runSimulatorSuite } =
		await import("../../scripts/simulator-evidence.mjs");
	const original = new Error("xcodebuild exit 65");
	const recorded = [];
	assert.throws(
		() =>
			runSimulatorSuite({
				execute() {
					throw original;
				},
				diagnostics() {
					recorded.push("diagnostics");
				},
				extract(kind) {
					recorded.push("extract:" + kind);
					return { kind };
				},
				save(kind, value) {
					assert.equal(kind, value.kind);
					recorded.push("save:" + kind);
				},
			}),
		(error) => error === original,
	);
	assert.deepEqual(recorded, [
		"diagnostics",
		"extract:summary",
		"save:summary",
		"extract:tests",
		"save:tests",
	]);
});

test("failed actions retain their error and every finalizer is attempted", async () => {
	const { withFinalizers, withAsyncFinalizers } =
		await import("../../scripts/verification-lifecycle.mjs");
	for (const execute of [withFinalizers, withAsyncFinalizers]) {
		const primary = new Error("xcodebuild failed");
		const extraction = new Error("summary extraction failed");
		const called = [];
		const invoke = () =>
			execute(() => {
				throw primary;
			}, [
				() => {
					called.push("summary");
					throw extraction;
				},
				() => {
					called.push("cases");
				},
				() => {
					called.push("attachments");
				},
				() => {
					called.push("remove");
				},
			]);
		const validate = (error) => {
			assert.equal(error.cause, primary);
			assert.deepEqual(error.errors, [primary, extraction]);
			assert.equal(error.message, primary.message);
			return true;
		};
		if (execute === withFinalizers) assert.throws(invoke, validate);
		else await assert.rejects(invoke, validate);
		assert.deepEqual(called, ["summary", "cases", "attachments", "remove"]);
	}
});

test("cleanup failure also rejects an otherwise successful action", async () => {
	const { withFinalizers, withAsyncFinalizers } =
		await import("../../scripts/verification-lifecycle.mjs");
	const failure = new Error("cannot remove AVD");
	assert.throws(
		() =>
			withFinalizers(
				() => 42,
				[
					() => {
						throw failure;
					},
				],
			),
		(error) => error === failure,
	);
	await assert.rejects(
		() =>
			withAsyncFinalizers(
				() => 42,
				[
					async () => {
						throw failure;
					},
				],
			),
		(error) => error === failure,
	);
});

test("process cleanup terminates and waits for only its owned child", async (t) => {
	const { stopOwnedChild } =
		await import("../../scripts/verification-lifecycle.mjs");
	const children = [0, 1].map(() =>
		spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
			detached: true,
			stdio: "ignore",
		}),
	);
	t.after(async () => {
		for (const child of children) await stopOwnedChild(child);
	});
	await Promise.all(children.map((child) => once(child, "spawn")));
	await stopOwnedChild(children[0], 1000);
	assert.notEqual(children[0].signalCode, null);
	assert.equal(children[1].exitCode, null);
	assert.equal(children[1].signalCode, null);
	assert.doesNotThrow(() => process.kill(children[1].pid, 0));
	await stopOwnedChild(children[0]);
});
