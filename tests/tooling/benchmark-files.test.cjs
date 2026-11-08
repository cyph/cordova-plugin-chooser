const test = require("node:test");
const assert = require("node:assert/strict");

test("all output paths preserve bytes with bounded reads and explicit copy ownership", async () => {
	const { runComparison } = await import("../../scripts/benchmark-files.mjs");
	const report = await runComparison({
		fixtureBytes: 524325,
		iterations: 2,
		warmups: 0,
	});
	assert.match(report.measurement, /Synthetic.*not native\/device throughput/);
	assert.equal(report.cases.length, 8);
	const [stream, managed, bytes, text, dataURI, combined, blob, arrayBuffer] =
		report.cases;
	for (const result of report.cases) {
		const { bridge, ownership, parity } = result.instrumentation;
		assert.equal(parity.verified, true);
		assert.equal(parity.sha256, report.fixture.sha256);
		assert.equal(bridge.readCalls, 3);
		assert.equal(bridge.bytesRead, report.fixture.bytes);
		assert.equal(bridge.maxRequestedReadBytes, 262144);
		assert.equal(bridge.maxReturnedReadBytes, 262144);
		assert.equal(bridge.calls.pick, 1);
		assert.equal(bridge.calls.releaseFile, 1);
		assert.equal(ownership.activeResources, 0);
		assert.equal(ownership.remainingTemporaryBytes, 0);
		assert.equal(result.timing.samplesMs.length, 2);
		assert(
			result.timing.samplesMs.every(
				(sample) => Number.isFinite(sample) && sample >= 0,
			),
		);
	}
	for (const result of [stream, managed]) {
		const { ownership } = result.instrumentation;
		assert.equal(ownership.managedCopiesCreated, 1);
		assert.equal(ownership.temporaryBytesWritten, report.fixture.bytes);
		assert.equal(ownership.temporaryBytesDeleted, report.fixture.bytes);
		assert.equal(ownership.peakTemporaryBytes, report.fixture.bytes);
	}
	assert.equal(
		stream.instrumentation.consumer.streamedBytes,
		report.fixture.bytes,
	);
	assert.equal(stream.instrumentation.consumer.largestStreamChunkBytes, 262144);
	assert.equal(stream.instrumentation.consumer.binaryBytes, undefined);
	assert.equal(
		managed.instrumentation.consumer.binaryBytes,
		report.fixture.bytes,
	);
	assert.equal(
		bytes.instrumentation.consumer.binaryBytes,
		report.fixture.bytes,
	);
	assert(text.instrumentation.consumer.textCodeUnits > 0);
	assert(
		dataURI.instrumentation.consumer.dataURICharacters > report.fixture.bytes,
	);
	assert.equal(
		combined.instrumentation.consumer.binaryBytes,
		report.fixture.bytes,
	);
	assert.equal(
		combined.instrumentation.consumer.dataURICharacters,
		dataURI.instrumentation.consumer.dataURICharacters,
	);
	// Additional output representations must not cause another bridge read pass.
	assert.equal(blob.instrumentation.consumer.blobBytes, report.fixture.bytes);
	assert.equal(
		arrayBuffer.instrumentation.consumer.arrayBufferBytes,
		report.fixture.bytes,
	);
	for (const result of [text, dataURI, combined, blob, arrayBuffer]) {
		assert.deepEqual(
			result.instrumentation.bridge,
			bytes.instrumentation.bridge,
		);
		assert.deepEqual(
			result.instrumentation.ownership,
			bytes.instrumentation.ownership,
		);
	}
	assert.equal(bytes.instrumentation.ownership.managedCopiesCreated, 0);
	assert.equal(bytes.instrumentation.ownership.temporaryBytesWritten, 0);
});

test("short provider reads and inaccurate reported size do not truncate direct text or base64", async () => {
	const { createFixture, runScenario } =
		await import("../../scripts/benchmark-files.mjs");
	const bytes = createFixture(524325);
	assert.deepEqual(bytes.subarray(262143, 262147), Buffer.from("🙂"));
	assert.throws(() =>
		new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 262144)),
	);
	for (const scenario of [
		"managed-stream",
		"direct-text",
		"direct-bytesAndDataURI",
		"direct-blob",
		"direct-arrayBuffer",
	]) {
		const result = await runScenario(scenario, bytes, {
			maxReadBytes: 65537,
			reportedSize: 1,
		});
		assert.equal(
			result.instrumentation.bridge.readCalls,
			Math.ceil(bytes.length / 65537),
		);
		assert.equal(result.instrumentation.bridge.maxReturnedReadBytes, 65537);
		assert.equal(result.instrumentation.parity.bytes, bytes.length);
	}
});

test("read failures still clean up and corrupted output fails byte-parity validation", async () => {
	const { createFixture, runScenario } =
		await import("../../scripts/benchmark-files.mjs");
	const bytes = createFixture(524325);
	for (const scenario of [
		"managed-stream",
		"managed-bytes",
		"direct-bytes",
		"direct-blob",
		"direct-arrayBuffer",
	]) {
		await assert.rejects(
			runScenario(scenario, bytes, { failReadAt: 2 }),
			(error) => error.code === "READ_FAILED",
		);
		await assert.rejects(
			runScenario(scenario, bytes, { corruptReadAt: 2 }),
			(error) => error.code === "ERR_ASSERTION",
		);
	}
});
