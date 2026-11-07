import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const chunkBytes = 262144;
const id = "12345678-1234-4234-8234-123456789abc";
const chooserURL = new URL("../www/chooser.js", import.meta.url);
export const scenarios = [
	"managed-stream",
	"managed-bytes",
	"direct-bytes",
	"direct-text",
	"direct-dataURI",
	"direct-bytesAndDataURI",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function createFixture(size = 2 * 1024 * 1024 + 37) {
	assert(Number.isSafeInteger(size) && size > chunkBytes * 2);
	const pattern = Buffer.from("Chooser RC2: café € 🙂 漢字\r\n");
	const bytes = Buffer.alloc(size, 0x61);
	for (
		let offset = 0;
		offset + pattern.length <= size;
		offset += pattern.length
	) {
		pattern.copy(bytes, offset);
	}
	// A valid character crosses the first bridge boundary in every fixture.
	const start = Math.floor((chunkBytes - 4) / pattern.length) * pattern.length;
	const end = Math.ceil((chunkBytes + 4) / pattern.length) * pattern.length;
	bytes.fill(0x61, start, end);
	Buffer.from("🙂").copy(bytes, chunkBytes - 1);
	new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return bytes;
}

function nativeFixture(bytes, options) {
	const maxReadBytes = options.maxReadBytes ?? chunkBytes;
	assert(Number.isSafeInteger(maxReadBytes) && maxReadBytes > 0);
	const resources = new Map();
	const metrics = {
		bridge: {
			calls: {},
			requestBytes: 0,
			responseBytes: 0,
			maxRequestBytes: 0,
			maxResponseBytes: 0,
			base64Characters: 0,
			readCalls: 0,
			bytesRead: 0,
			maxRequestedReadBytes: 0,
			maxReturnedReadBytes: 0,
		},
		ownership: {
			createdResources: 0,
			releasedResources: 0,
			activeResources: 0,
			managedCopiesCreated: 0,
			temporaryBytesWritten: 0,
			temporaryBytesDeleted: 0,
			peakTemporaryBytes: 0,
			remainingTemporaryBytes: 0,
		},
	};
	const { bridge, ownership } = metrics;
	function serialize(value, direction) {
		const json = JSON.stringify(value);
		const length = Buffer.byteLength(json);
		bridge[`${direction}Bytes`] += length;
		const max = `max${direction[0].toUpperCase()}${direction.slice(1)}Bytes`;
		bridge[max] = Math.max(bridge[max], length);
		return json;
	}
	function perform(action, args) {
		if (action === "pick") {
			const [request] = args;
			assert.equal(resources.size, 0);
			assert.equal(request.multiple, false);
			assert.equal(request.source, "documents");
			assert.equal(request.maxFileSize, bytes.length);
			assert(["copy", "data"].includes(request.mode));
			const managed = request.mode === "copy";
			resources.set(id, {
				managed,
				bytes: managed ? Buffer.from(bytes) : bytes,
				offset: 0,
			});
			ownership.createdResources++;
			ownership.activeResources++;
			if (managed) {
				ownership.managedCopiesCreated++;
				ownership.temporaryBytesWritten += bytes.length;
				ownership.remainingTemporaryBytes += bytes.length;
				ownership.peakTemporaryBytes = ownership.remainingTemporaryBytes;
			}
			return {
				id,
				name: "fixture.txt",
				mediaType: "text/plain",
				size: managed ? bytes.length : (options.reportedSize ?? null),
				...(managed
					? { uri: `file:///synthetic-cache/${id}` }
					: { kind: "source" }),
			};
		}
		assert.equal(args[0], id);
		const resource = resources.get(id);
		assert(
			resource,
			"The bridge must never read or release an unowned resource",
		);
		if (action === "readFile") {
			const [, offset, length] = args;
			assert(Number.isSafeInteger(offset) && offset >= 0);
			assert(
				Number.isSafeInteger(length) && length > 0 && length <= chunkBytes,
			);
			assert.equal(
				offset,
				resource.offset,
				"All scenarios must make one sequential content pass",
			);
			bridge.readCalls++;
			bridge.maxRequestedReadBytes = Math.max(
				bridge.maxRequestedReadBytes,
				length,
			);
			if (options.failReadAt === bridge.readCalls) {
				throw { code: "READ_FAILED", message: "Synthetic read failure" };
			}
			const part = resource.bytes.subarray(
				offset,
				offset + Math.min(length, maxReadBytes),
			);
			bridge.bytesRead += part.length;
			bridge.maxReturnedReadBytes = Math.max(
				bridge.maxReturnedReadBytes,
				part.length,
			);
			resource.offset += part.length;
			let data = part.toString("base64");
			if (options.corruptReadAt === bridge.readCalls && part.length) {
				const corrupt = Buffer.from(part);
				corrupt[0] ^= 1;
				data = corrupt.toString("base64");
			}
			bridge.base64Characters += data.length;
			return { data, eof: resource.offset === bytes.length };
		}
		assert.equal(action, "releaseFile", "Unexpected bridge action");
		if (resource.managed) {
			ownership.temporaryBytesDeleted += resource.bytes.length;
			ownership.remainingTemporaryBytes -= resource.bytes.length;
		}
		resources.delete(id);
		ownership.activeResources--;
		ownership.releasedResources++;
		return null;
	}
	return {
		metrics,
		exec(ok, fail, service, action, args) {
			assert.equal(service, "Chooser");
			bridge.calls[action] = (bridge.calls[action] || 0) + 1;
			// Cross a JSON boundary in both directions, including the request envelope.
			const request = JSON.parse(
				serialize({ service, action, args }, "request"),
			);
			queueMicrotask(() => {
				try {
					ok(serialize(perform(action, request.args), "response"));
				} catch (error) {
					fail(
						serialize(
							{ code: error.code || "READ_FAILED", message: error.message },
							"response",
						),
					);
				}
			});
		},
	};
}

function loadChooser(source, exec) {
	const context = {
		module: { exports: {} },
		require(name) {
			assert.equal(name, "cordova/exec");
			return exec;
		},
		Promise,
		Uint8Array,
		ArrayBuffer,
		Blob,
		ReadableStream,
		TextDecoder,
		TextEncoder,
		AbortController,
		AbortSignal,
	};
	vm.runInNewContext(source, context, { filename: "www/chooser.js" });
	return context.module.exports;
}

export async function runScenario(scenario, bytes, options = {}) {
	assert(scenarios.includes(scenario), "Unknown benchmark scenario");
	const source = options.chooserSource ?? (await readFile(chooserURL, "utf8"));
	const fixture = nativeFixture(bytes, options);
	const chooser = loadChooser(source, fixture.exec);
	const originalHash = sha256(bytes);
	let file, result, streamHash, elapsedMs;
	let streamedBytes = 0,
		largestStreamChunkBytes = 0;
	const started = performance.now();
	try {
		if (scenario.startsWith("managed-")) {
			file = await chooser.getFile({ maxFileSize: bytes.length });
			try {
				if (scenario === "managed-bytes")
					result = { data: await file.bytes({ maxBytes: bytes.length }) };
				else {
					const hash = createHash("sha256");
					const reader = file.stream().getReader();
					try {
						while (true) {
							const { value, done } = await reader.read();
							if (done) break;
							streamedBytes += value.byteLength;
							largestStreamChunkBytes = Math.max(
								largestStreamChunkBytes,
								value.byteLength,
							);
							hash.update(value);
						}
					} finally {
						reader.releaseLock();
					}
					streamHash = hash.digest("hex");
				}
			} finally {
				await file.release();
			}
		} else {
			result = await chooser.getFileData({
				maxFileSize: bytes.length,
				format: scenario.slice("direct-".length),
			});
		}
	} finally {
		elapsedMs = performance.now() - started;
		assert.equal(
			fixture.metrics.ownership.activeResources,
			0,
			"The scenario leaked a managed copy or transient reader",
		);
		assert.equal(
			fixture.metrics.ownership.remainingTemporaryBytes,
			0,
			"The scenario leaked temporary bytes",
		);
		assert.equal(
			sha256(bytes),
			originalHash,
			"The source must survive cleanup unchanged",
		);
	}
	// Do not concatenate streamed bytes just to validate them. Hash parity is checked
	// after the timed operation; the streaming sink's incremental hashing is timed.
	const representations = {};
	if (scenario === "managed-stream") {
		assert.equal(streamedBytes, bytes.length);
		assert.equal(streamHash, originalHash);
	} else {
		assert.equal(
			"id" in result,
			false,
			"Data results must not transfer resource ownership",
		);
		assert.equal("uri" in result, false);
		if (result.data !== undefined) {
			assert.deepEqual(Buffer.from(result.data), bytes);
			representations.binaryBytes = result.data.byteLength;
		}
		if (result.text !== undefined) {
			assert.deepEqual(Buffer.from(result.text, "utf8"), bytes);
			representations.textCodeUnits = result.text.length;
		}
		if (result.dataURI !== undefined) {
			const prefix = "data:text/plain;base64,";
			assert(result.dataURI.startsWith(prefix));
			assert.equal(
				result.dataURI.slice(prefix.length),
				bytes.toString("base64"),
			);
			representations.dataURICharacters = result.dataURI.length;
		}
		assert(
			Object.keys(representations).length > 0,
			"No output representation was verified",
		);
	}
	assert.equal(fixture.metrics.bridge.bytesRead, bytes.length);
	assert.equal(fixture.metrics.ownership.createdResources, 1);
	assert.equal(fixture.metrics.ownership.releasedResources, 1);
	return {
		scenario,
		instrumentation: {
			...fixture.metrics,
			consumer: { streamedBytes, largestStreamChunkBytes, ...representations },
			parity: { bytes: bytes.length, sha256: originalHash, verified: true },
		},
		elapsedMs,
	};
}

export async function runComparison({
	fixtureBytes,
	iterations = 3,
	warmups = 1,
	maxReadBytes = chunkBytes,
} = {}) {
	assert(Number.isSafeInteger(iterations) && iterations > 0);
	assert(Number.isSafeInteger(warmups) && warmups >= 0);
	const bytes = createFixture(fixtureBytes);
	const chooserSource = await readFile(chooserURL, "utf8");
	const cases = [];
	for (const scenario of scenarios) {
		let instrumentation;
		const samples = [];
		for (let run = -warmups; run < iterations; run++) {
			const result = await runScenario(scenario, bytes, {
				chooserSource,
				maxReadBytes,
			});
			if (run < 0) continue;
			if (instrumentation)
				assert.deepEqual(result.instrumentation, instrumentation);
			else instrumentation = result.instrumentation;
			samples.push(result.elapsedMs);
		}
		const sorted = samples.toSorted((a, b) => a - b);
		const middle = Math.floor(sorted.length / 2);
		cases.push({
			scenario,
			instrumentation,
			timing: {
				samplesMs: samples,
				medianMs:
					sorted.length % 2
						? sorted[middle]
						: (sorted[middle - 1] + sorted[middle]) / 2,
				minMs: sorted[0],
				maxMs: sorted.at(-1),
			},
		});
	}
	return {
		schema: 1,
		measurement:
			"Synthetic in-memory Cordova bridge; not native/device throughput",
		boundaries: {
			bridgeBytes:
				"UTF-8 JSON request envelopes and callback payloads; excludes Cordova transport framing",
			temporaryBytes:
				"Explicit Buffer copies in the fixture model; not measured filesystem writes or provider imports",
			timing:
				"Informational instrumented pick + consume + cleanup; includes JSON/base64 and incremental SHA-256 for the stream sink; excludes module load and final parity/ownership checks. Fixed scenario order, no timing thresholds.",
			processMemory:
				"Not reported: shared-process V8 allocation/GC and retained fixture buffers cannot establish per-path peak memory",
		},
		runtime: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		implementation: { path: "www/chooser.js", sha256: sha256(chooserSource) },
		fixture: {
			bytes: bytes.length,
			sha256: sha256(bytes),
			encoding: "utf-8",
			chunkBytes,
			maxReadBytes,
		},
		iterations,
		warmups,
		cases,
	};
}

async function main(args) {
	const options = {};
	let output;
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index],
			value = args[index + 1];
		assert(value !== undefined, `Missing value for ${flag}`);
		if (flag === "--output") output = value;
		else {
			const key = {
				"--bytes": "fixtureBytes",
				"--iterations": "iterations",
				"--warmups": "warmups",
				"--max-read-bytes": "maxReadBytes",
			}[flag];
			assert(key, `Unknown argument: ${flag}`);
			assert(/^\d+$/.test(value), `Invalid integer for ${flag}`);
			options[key] = Number(value);
		}
	}
	const report = JSON.stringify(await runComparison(options), null, 2) + "\n";
	if (output) await writeFile(output, report);
	else process.stdout.write(report);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
