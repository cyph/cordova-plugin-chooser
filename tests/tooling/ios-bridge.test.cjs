const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = readFileSync(
	join(__dirname, "../ios/simulator/bridge.html"),
	"utf8",
);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function fixture(options = {}) {
	const messages = [],
		calls = [],
		timers = new Map(),
		listeners = new Map();
	let nextTimer = 0;
	const expected = {
		id: "seed",
		uri: "file:///managed/seed",
		name: "binary",
		mediaType: "application/octet-stream",
		size: 4,
	};
	const bytes = [0, 127, 128, 255];
	class ChooserError extends Error {}
	const missingError = Object.assign(new ChooserError("Missing native file"), {
		code: "FILE_UNAVAILABLE",
		cause: { code: "FILE_UNAVAILABLE" },
	});
	const context = {
		__chooserBridgeNonce: "nonce",
		Uint8Array,
		cordova: { platformId: "ios" },
		webkit: {
			messageHandlers: {
				chooserBridge: { postMessage: (value) => messages.push(value) },
			},
		},
		addEventListener: (name, callback) => listeners.set(name, callback),
		document: {
			addEventListener: (name, callback) => listeners.set(name, callback),
		},
		setTimeout: (callback, milliseconds) => {
			const id = ++nextTimer;
			timers.set(id, { callback, milliseconds });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
		chooser: {
			ChooserError,
			restoreFile: async (reference) => {
				calls.push(["restore", reference.id]);
				if (reference.id === "missing")
					throw options.missingError || missingError;
				return {
					id: expected.id,
					toJSON: () => ({ ...expected }),
					readRange: async (range) => {
						calls.push(["readRange", range.offset, range.length]);
						return new Uint8Array(
							options.badBytes ? [255, 128, 127, 0] : bytes,
						);
					},
					release: async () => {
						calls.push(["release"]);
						if (options.releaseFailure)
							throw new Error("Native release failed");
					},
				};
			},
		},
	};
	context.window = context;
	vm.runInNewContext(script, context);
	const args = {
		nonce: "nonce",
		reference: { ...expected, uri: "file:///old", size: 99 },
		expected,
		bytes,
		missingReference: { ...expected, id: "missing" },
	};
	return {
		context,
		messages,
		calls,
		timers,
		args,
		ready: () => listeners.get("deviceready")(),
		run: (value) => context.chooserBridgeRun(value || args),
		fireTimer: (milliseconds) => {
			const timer = [...timers.values()].find(
				(t) => t.milliseconds === milliseconds,
			);
			assert(timer);
			timer.callback();
		},
	};
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("bridge page checks the public roundtrip and returns synchronous invocation acknowledgement", async () => {
	const f = fixture();
	f.ready();
	assert.equal(f.run(), true);
	await settle();
	assert.deepEqual(f.calls, [
		["restore", "seed"],
		["readRange", 0, 4],
		["release"],
		["restore", "missing"],
	]);
	assert.deepEqual(
		f.messages.map((m) => m.kind),
		["ready", "complete"],
	);
	const complete = f.messages[1];
	assert.equal(complete.nonce, "nonce");
	assert.equal(complete.readyCount, 1);
	assert.equal(complete.completionCount, 1);
	assert.deepEqual(Array.from(complete.bytes), [0, 127, 128, 255]);
	assert.equal(complete.missingError.causeCode, "FILE_UNAVAILABLE");
	assert.equal(f.timers.size, 0);
});

test("bridge page rejects startup and operation deadline expiration", async () => {
	const startup = fixture();
	startup.fireTimer(60000);
	assert.equal(startup.messages[0].kind, "error");
	startup.ready();
	assert.equal(startup.run(), false);
	assert.equal(startup.calls.length, 0);
	const operation = fixture();
	operation.ready();
	assert.equal(operation.run(), true);
	operation.fireTimer(30000);
	await settle();
	assert(!operation.messages.some((m) => m.kind === "complete"));
	assert(operation.messages.some((m) => m.kind === "error"));
});

test("bridge page rejects stale nonces, duplicate readiness and duplicate invocations", async () => {
	const wrongNonce = fixture();
	wrongNonce.ready();
	assert.equal(wrongNonce.run({ ...wrongNonce.args, nonce: "old" }), false);
	assert.equal(wrongNonce.calls.length, 0);
	const duplicateReady = fixture();
	duplicateReady.ready();
	duplicateReady.ready();
	assert.equal(duplicateReady.run(), false);
	const duplicateRun = fixture();
	duplicateRun.ready();
	assert.equal(duplicateRun.run(), true);
	assert.equal(duplicateRun.run(), false);
	await settle();
	assert(!duplicateRun.messages.some((m) => m.kind === "complete"));
});

test("bridge page rejects corrupted bytes, release failures and untyped native errors", async () => {
	for (const options of [
		{ badBytes: true },
		{ releaseFailure: true },
		{
			missingError: Object.assign(new Error("Class missing"), {
				code: "FILE_UNAVAILABLE",
			}),
		},
	]) {
		const f = fixture(options);
		f.ready();
		assert.equal(f.run(), true);
		await settle();
		assert(f.messages.some((m) => m.kind === "error"));
		assert(!f.messages.some((m) => m.kind === "complete"));
	}
});
