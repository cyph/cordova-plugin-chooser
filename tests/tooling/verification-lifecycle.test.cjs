const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

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
		"extract:summary",
		"save:summary",
		"extract:tests",
		"save:tests",
		"diagnostics",
	]);
});

test("simulator validation and extraction failures also retain diagnostics", async () => {
	const { runSimulatorSuite } =
		await import("../../scripts/simulator-evidence.mjs");
	for (const failure of [
		"missing",
		"renamed",
		"skipped",
		"summary",
		"tests",
		"save",
		"none",
	]) {
		const recorded = [];
		const summary = {
			totalTestCount: 1,
			passedTests: 1,
			failedTests: 0,
			skippedTests: 0,
		};
		const tests = {
			testNodes: [
				{
					nodeType: "Test Case",
					nodeIdentifier:
						failure === "renamed" ? "Suite/other()" : "Suite/test()",
					result: failure === "skipped" ? "Skipped" : "Passed",
				},
			],
		};
		if (failure === "missing") tests.testNodes = [];
		const invoke = () =>
			runSimulatorSuite({
				execute() {},
				extract(kind) {
					recorded.push("extract:" + kind);
					if (failure === kind) throw new Error("invalid " + kind);
					return kind === "summary" ? summary : tests;
				},
				save(kind) {
					recorded.push("save:" + kind);
					if (failure === "save") throw new Error("cannot save " + kind);
				},
				diagnostics() {
					recorded.push("diagnostics");
				},
				required: ["Suite/test()"],
			});
		if (failure === "none") assert.doesNotThrow(invoke);
		else assert.throws(invoke);
		assert(recorded.includes("extract:summary"));
		assert(recorded.includes("extract:tests"));
		assert.equal(
			recorded.filter((item) => item === "diagnostics").length,
			failure === "none" ? 0 : 1,
		);
	}
});

test("diagnostic failures preserve the original simulator failure", async () => {
	const { runSimulatorSuite } =
		await import("../../scripts/simulator-evidence.mjs");
	const primary = new Error("xcodebuild failed");
	const diagnostic = new Error("cannot export diagnostics");
	assert.throws(
		() =>
			runSimulatorSuite({
				execute() {
					throw primary;
				},
				extract() {
					return {};
				},
				save() {},
				diagnostics() {
					throw diagnostic;
				},
			}),
		(error) => {
			assert.equal(error.cause, primary);
			assert.deepEqual(error.errors, [primary, diagnostic]);
			return true;
		},
	);
});

test("instrumentation evidence copying preserves a simultaneous Gradle failure", async (t) => {
	const { runInstrumentation } = await import("../../scripts/capacitor.mjs");
	const directory = mkdtempSync(join(tmpdir(), "chooser-evidence-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const results = join(directory, "results");
	const blocked = join(directory, "blocked");
	mkdirSync(results);
	writeFileSync(join(results, "TEST-fixture.xml"), "<testsuite/>");
	writeFileSync(blocked, "existing file");
	const primary = new Error("Gradle failed");
	assert.throws(
		() =>
			runInstrumentation(
				() => {
					throw primary;
				},
				results,
				blocked,
			),
		(error) => {
			assert.equal(error.cause, primary);
			assert.equal(error.errors[0], primary);
			assert.equal(error.errors.length, 2);
			assert(error.errors[1].code);
			return true;
		},
	);
	assert.throws(() => runInstrumentation(() => {}, results, blocked));
	assert.equal(readFileSync(blocked, "utf8"), "existing file");
	const destination = join(directory, "retained");
	assert.throws(
		() =>
			runInstrumentation(
				() => {
					throw primary;
				},
				results,
				destination,
			),
		(error) => error === primary,
	);
	assert.equal(
		readFileSync(join(destination, "TEST-fixture.xml"), "utf8"),
		"<testsuite/>",
	);
	assert.throws(
		() =>
			runInstrumentation(
				() => {
					throw primary;
				},
				join(directory, "missing"),
				destination,
			),
		(error) => error === primary,
	);
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

test(
	"process cleanup escalates for descendants even after the parent exits",
	{ timeout: 15_000 },
	async (t) => {
		const { stopOwnedChild } =
			await import("../../scripts/verification-lifecycle.mjs");
		for (const exitBeforeCleanup of [false, true]) {
			const descendant =
				"process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000);";
			const source = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>process.send('ready',()=>{if(${exitBeforeCleanup}) process.exit(0);})); setInterval(()=>{},1000);`;
			const child = spawn(process.execPath, ["-e", source], {
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			t.after(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
			});
			const exited = once(child, "exit");
			await once(child, "message");
			if (exitBeforeCleanup) await exited;
			await stopOwnedChild(child, 1000);
			await exited;
			assert.throws(
				() => process.kill(-child.pid, 0),
				(error) => error.code === "ESRCH",
			);
			await stopOwnedChild(child, 1000);
		}
	},
);
