const test = require('node:test');
const assert = require('node:assert/strict');
const {loadChooser} = require('./helpers');

const key = '12345678-1234-4234-8234-123456789abc';
const secondKey = '12345678-1234-4234-8234-123456789abd';
const tick = () => new Promise(setImmediate);
const code = expected => error => error.code === expected;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(bytes = Buffer.from('abc'), options = {}) {
	const calls = [], reads = [], releases = [], pending = [], releasePending = [];
	let releaseFailures = options.releaseFailures || 0;
	const ref = {id: key, uri: 'file:///cache/' + key, name: 'sample.bin', mediaType: 'application/octet-stream', size: options.recordedSize ?? bytes.length};
	const chooser = loadChooser((ok, fail, service, action, args) => {
		assert.equal(service, 'Chooser');
		calls.push({action, args: plain(args)});
		if (action === 'pick') ok(ref);
		else if (action === 'statFile') ok(options.stat || {id: key, uri: ref.uri, size: bytes.length});
		else if (action === 'readFile') {
			const [id, offset, length] = args;
			assert.equal(id, key);
			assert.ok(length <= 262144);
			reads.push({offset, length});
			const finish = () => {
				if (options.readResult) { ok(options.readResult); return; }
				const part = bytes.subarray(offset, offset + Math.min(length, options.shortReads || length));
				ok({data: part.toString('base64'), eof: offset + part.length >= bytes.length});
			};
			if (options.holdReads) pending.push(finish);
			else finish();
		}
		else if (action === 'releaseFile') {
			releases.push(args[0]);
			if (releaseFailures-- > 0) fail({code: 'RELEASE_FAILED', message: 'busy provider'});
			else if (options.holdRelease) releasePending.push(ok);
			else ok();
		}
		else throw new Error('Unexpected bridge action: ' + action);
	});
	return {chooser, calls, reads, releases, pending, releasePending, ref};
}

test('whole reads and combined data produce exact bytes across multiple bounded bridge chunks', async () => {
	const bytes = Buffer.from(Array.from({length: 700003}, (_, i) => (i * 37) & 255));
	const f = fixture(bytes);
	const file = await f.chooser.getFile({maxFileSize: null});
	const both = await file.getData({format: 'bytesAndDataURI', maxBytes: bytes.length});
	assert.deepEqual(Buffer.from(both.data), bytes);
	assert.equal(both.dataURI.split(',')[1], bytes.toString('base64'));
	assert.equal('id' in both, false);
	assert.equal('uri' in both, false);
	assert.equal(both.size, bytes.length);
	assert.equal(f.reads.length, 3, 'combined output uses one content pass');
	assert.deepEqual(f.reads.map(read => read.offset), [0, 262144, 524288]);
	assert.equal(both.data.buffer instanceof ArrayBuffer, true);
	assert.deepEqual(Buffer.from(await file.arrayBuffer({maxBytes: null})), bytes);
	assert.deepEqual(Buffer.from(await (await file.blob({maxBytes: null})).arrayBuffer()), bytes);
});

test('managed Blob and ArrayBuffer data include metadata without changing raw read results or ownership', async () => {
	for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1]), Buffer.alloc(524293, 0xa5)]) {
		const f = fixture(bytes, {shortReads: 65537});
		const file = await f.chooser.getFile({maxFileSize: null});
		for (const format of ['blob', 'arrayBuffer']) {
			const result = await file.getData({format, maxBytes: bytes.length || 1});
			assert.equal(result.format, format);
			assert.equal(result.size, bytes.length);
			assert.equal(result.name, f.ref.name);
			assert.equal(result.mediaType, f.ref.mediaType);
			assert.equal('id' in result, false);
			assert.equal('uri' in result, false);
			assert.equal('data' in result, false);
			const raw = format === 'blob' ? await file.blob({maxBytes: null}) : await file.arrayBuffer({maxBytes: null});
			assert.ok(raw instanceof (format === 'blob' ? Blob : ArrayBuffer));
			const actual = format === 'blob' ? await result.blob.arrayBuffer() : result.arrayBuffer;
			assert.deepEqual(Buffer.from(actual), bytes);
			if (format === 'blob') assert.equal(result.blob.type, f.ref.mediaType);
			if (bytes.length > 1) await assert.rejects(file.getData({format, maxBytes: bytes.length - 1}), code('FILE_TOO_LARGE'));
		}
		assert.deepEqual(f.releases, []);
		await file.release();
		assert.deepEqual(f.releases, [key]);
	}
});

test('managed text APIs use flat decoding options and binary APIs reject them before reading', async () => {
	const f = fixture(Buffer.from([0xe9]));
	const file = await f.chooser.getFile({maxFileSize: null});
	assert.equal(file.read, undefined, 'readRange has no legacy alias');
	assert.equal(await file.text({maxBytes: null, encoding: 'windows-1252'}), 'é');
	assert.equal((await file.getData({format: 'text', maxBytes: null, encoding: 'windows-1252'})).text, 'é');
	assert.equal((await file.getData({format: 'text', maxBytes: null, fatal: false})).text, '\ufffd');
	const reader = file.textStream({encoding: 'windows-1252'}).getReader();
	assert.equal((await reader.read()).value, 'é');
	assert.equal((await reader.read()).done, true);
	const before = f.reads.length;
	for (const format of ['bytes', 'blob', 'arrayBuffer', 'dataURI', 'bytesAndDataURI']) {
		for (const option of [{encoding: 'utf-8'}, {fatal: false}, {fatal: undefined}, {decoding: {fatal: false}}]) {
			await assert.rejects(file.getData({format, maxBytes: null, ...option}), code('INVALID_ARGUMENT'));
		}
	}
	for (const method of ['bytes', 'blob', 'arrayBuffer', 'dataURI']) {
		await assert.rejects(file[method]({maxBytes: null, fatal: false}), code('INVALID_ARGUMENT'));
	}
	await assert.rejects(file.text({maxBytes: null, decoding: {fatal: false}}), code('INVALID_ARGUMENT'));
	await assert.rejects(file.getData({format: 'text', maxBytes: null, decoding: {fatal: false}}), code('INVALID_ARGUMENT'));
	assert.throws(() => file.textStream({decoding: {fatal: false}}), code('INVALID_ARGUMENT'));
	assert.throws(() => file.stream({encoding: 'utf-8'}), code('INVALID_ARGUMENT'));
	await assert.rejects(file.readRange({length: 1, fatal: false}), code('INVALID_ARGUMENT'));
	assert.equal(f.reads.length, before);
	await file.release();
});

test('ranges larger than internal chunks are supported with exact EOF and zero-length behavior', async () => {
	const bytes = Buffer.alloc(600000, 0xa5);
	const f = fixture(bytes);
	const file = await f.chooser.getFile({maxFileSize: null});
	assert.equal((await file.readRange({offset: 100, length: 500000})).length, 500000);
	assert.deepEqual(f.reads, [{offset: 100, length: 262144}, {offset: 262244, length: 237856}]);
	assert.equal((await file.readRange({offset: 599999, length: 100})).length, 1);
	assert.equal((await file.readRange({offset: 700000, length: 1})).length, 0);
	const count = f.reads.length;
	assert.equal((await file.readRange({length: 0})).length, 0);
	assert.equal(f.reads.length, count);
	for (const options of [{length: -1}, {length: 1.1}, {length: 1, offset: -1}, {length: 1, offset: Number.MAX_SAFE_INTEGER}]) {
		await assert.rejects(file.readRange(options), code('INVALID_ARGUMENT'));
	}
});

test('managed reads require independent materialization budgets and validate every method option', async () => {
	const f = fixture();
	const file = await f.chooser.getFile({maxFileSize: null});
	for (const method of ['bytes', 'arrayBuffer', 'blob', 'text', 'dataURI']) {
		await assert.rejects(file[method](), code('INVALID_ARGUMENT'));
		await assert.rejects(file[method]({maxBytes: 0}), code('INVALID_ARGUMENT'));
		await assert.rejects(file[method]({maxBytes: null}, () => {}), code('INVALID_ARGUMENT'));
		await assert.rejects(file[method]({maxBytes: 2}), code('FILE_TOO_LARGE'));
	}
	await assert.rejects(file.getData({maxBytes: null}), code('INVALID_ARGUMENT'));
	await assert.rejects(file.getData({maxBytes: null, format: 'bytes', decoding: {fatal: false}}), code('INVALID_ARGUMENT'));
	await assert.rejects(file.readRange({length: 0}, () => {}), code('INVALID_ARGUMENT'));
	assert.throws(() => file.stream({length: -1}), code('INVALID_ARGUMENT'));
	assert.throws(() => file.textStream({encoding: 'no-such-encoding'}), code('INVALID_ARGUMENT'));
});

test('stream backpressure performs no eager read and cancellation closes only its reader', async () => {
	const f = fixture(Buffer.alloc(700000, 42));
	const file = await f.chooser.getFile({maxFileSize: null});
	const stream = file.stream();
	await tick();
	assert.equal(f.reads.length, 0);
	const reader = stream.getReader();
	const first = await reader.read();
	assert.equal(first.value.length, 262144);
	await tick();
	assert.equal(f.reads.length, 1, 'no second chunk before another pull');
	await reader.cancel();
	assert.equal(f.releases.length, 0);
	assert.deepEqual(Array.from(await file.readRange({length: 2})), [42, 42]);
});

test('text streams decode characters split across byte reads and flush final decoder state', async () => {
	const text = 'a\u20ac\ud83d\ude42z';
	const f = fixture(Buffer.from(text), {shortReads: 1});
	const file = await f.chooser.getFile({maxFileSize: null});
	assert.equal(await file.text({maxBytes: null}), text);
	const reader = file.textStream().getReader();
	let actual = '';
	while (true) { const result = await reader.read(); if (result.done) break; actual += result.value; }
	assert.equal(actual, text);
	const broken = fixture(Buffer.from([0xe2, 0x82]), {shortReads: 1});
	const invalid = await broken.chooser.getFile({maxFileSize: null});
	const invalidReader = invalid.textStream().getReader();
	await assert.rejects(invalidReader.read(), code('DECODE_FAILED'));
	const replacement = invalid.textStream({fatal: false}).getReader();
	assert.equal((await replacement.read()).value, '\ufffd');
	assert.equal((await replacement.read()).done, true);
});

test('release stops unread streams without hanging and rejects future reads through every alias', async () => {
	const f = fixture();
	const file = await f.chooser.getFile({maxFileSize: null});
	const restored = await f.chooser.restoreFile(file.toJSON());
	const stream = file.stream();
	const reader = stream.getReader();
	const closed = assert.rejects(reader.closed, code('FILE_RELEASED'));
	await restored.release();
	await closed;
	await assert.rejects(file.bytes({maxBytes: null}), code('FILE_RELEASED'));
	await assert.rejects(restored.readRange({length: 1}), code('FILE_RELEASED'));
	assert.throws(() => file.stream(), code('FILE_RELEASED'));
	await f.chooser.releaseFile(file.id);
	assert.deepEqual(f.releases, [key]);
});

test('release waits for an already-started whole read, including its later chunks', async () => {
	const bytes = Buffer.alloc(300000, 9);
	const f = fixture(bytes, {holdReads: true});
	const file = await f.chooser.getFile({maxFileSize: null});
	const read = file.bytes({maxBytes: null});
	const released = file.release();
	await assert.rejects(file.readRange({length: 1}), code('FILE_RELEASED'));
	await tick();
	assert.equal(f.pending.length, 1);
	assert.equal(f.releases.length, 0);
	f.pending.shift()();
	await tick();
	assert.equal(f.releases.length, 0);
	assert.equal(f.pending.length, 1);
	f.pending.shift()();
	assert.deepEqual(Buffer.from(await read), bytes);
	await released;
	assert.deepEqual(f.releases, [key]);
});

test('release errors a pending stream immediately but defers native deletion until its I/O finishes', async () => {
	const f = fixture(Buffer.alloc(300000), {holdReads: true});
	const file = await f.chooser.getFile({maxFileSize: null});
	const reader = file.stream().getReader();
	const pendingRead = assert.rejects(reader.read(), code('FILE_RELEASED'));
	const closed = assert.rejects(reader.closed, code('FILE_RELEASED'));
	await tick();
	const releasing = file.release();
	await pendingRead; await closed;
	assert.equal(f.releases.length, 0);
	f.pending.shift()();
	await releasing;
	assert.equal(f.reads.length, 1);
	assert.deepEqual(f.releases, [key]);
});

test('stream cancellation does not wait for an unrelated whole-file read', async () => {
	const f = fixture(Buffer.from('abc'), {holdReads: true});
	const file = await f.chooser.getFile({maxFileSize: null});
	const read = file.bytes({maxBytes: null});
	await tick();
	await file.stream().cancel();
	assert.equal(f.releases.length, 0);
	f.pending.shift()();
	assert.equal((await read).length, 3);
});

test('the scheduler queues normal concurrent reads behind four active bridge jobs', async () => {
	const f = fixture(Buffer.from('abc'), {holdReads: true});
	const file = await f.chooser.getFile({maxFileSize: null});
	const reads = Array.from({length: 9}, () => file.readRange({length: 1}));
	await tick();
	assert.equal(f.pending.length, 4);
	assert.equal(f.reads.length, 4);
	while (f.reads.length < 9 || f.pending.length) {
		const ready = f.pending.splice(0);
		ready.forEach(finish => finish());
		await tick();
		assert.ok(f.pending.length <= 4);
	}
	assert.deepEqual((await Promise.all(reads)).map(bytes => bytes[0]), Array(9).fill(97));
});

test('signal cancellation of managed I/O waits for native completion and never cancels other readers', async () => {
	const f = fixture(Buffer.from('abc'), {holdReads: true});
	const file = await f.chooser.getFile({maxFileSize: null});
	const controller = new AbortController();
	const cancelled = file.bytes({maxBytes: null, signal: controller.signal});
	const cancelledCheck = assert.rejects(cancelled, error => error instanceof f.chooser.CancellationError && error.reason === 'signal');
	await tick();
	controller.abort();
	const releasing = file.release();
	await tick();
	assert.equal(f.releases.length, 0);
	assert.equal(f.calls.some(call => call.action === 'cancelRead'), false);
	f.pending.shift()();
	await cancelledCheck;
	await releasing;
});

test('batch release validates every ID first, deduplicates attempts, and reports retryable per-ID errors', async () => {
	const f = fixture(undefined, {releaseFailures: 1});
	await assert.rejects(f.chooser.releaseFiles([key, '../foreign']), code('INVALID_ARGUMENT'));
	assert.equal(f.releases.length, 0);
	await assert.rejects(f.chooser.releaseFiles([key, secondKey, key]), error => error.code === 'RELEASE_FAILED' && error.failures.length === 1 && error.failures[0].id === key && error.failures[0].error instanceof f.chooser.ChooserError);
	assert.deepEqual(f.releases, [key, secondKey]);
	await f.chooser.releaseFiles([key, secondKey]);
	assert.deepEqual(f.releases, [key, secondKey, key]);
});

test('batch release rejects holes, inherited entries and invalid IDs before mutating any resource', async () => {
	const inherited = [key, , secondKey];
	Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {1: secondKey}));
	for (const ids of [Array(1), [key, , secondKey], [key, undefined], [key, key, , secondKey], inherited]) {
		const f = fixture();
		const file = await f.chooser.getFile({maxFileSize: null});
		const before = f.calls.length;
		await assert.rejects(f.chooser.releaseFiles(ids), code('INVALID_ARGUMENT'));
		assert.equal(f.calls.length, before, 'validation must precede every release dispatch');
		assert.deepEqual(f.releases, []);
		assert.deepEqual(Array.from(await file.readRange({length: 1})), [97], 'invalid input must not mark the valid file releasing');
	}
});

test('batch release validates the exact indexed snapshot it releases, ignoring custom iteration', async () => {
	const f = fixture();
	let accesses = 0;
	const ids = [key, secondKey, key];
	Object.defineProperty(ids, 0, {get() { return ++accesses === 1 ? key : '../foreign'; }});
	ids.forEach = () => {};
	ids[Symbol.iterator] = function* () { yield '../foreign'; };
	await f.chooser.releaseFiles(ids);
	assert.equal(accesses, 1, 'no second read of user-controlled entries after validation');
	assert.deepEqual(f.releases, [key, secondKey]);
});

test('saved RC1 identifiers remain releasable without an in-memory registration', async () => {
	const f = fixture();
	await f.chooser.releaseFile(key);
	assert.deepEqual(f.calls.map(call => call.action), ['releaseFile']);
});

test('restore accepts unknown input, validates it before dispatch, and uses authoritative stat URI and size', async () => {
	const f = fixture(Buffer.from('abcdef'), {stat: {id: key, uri: 'file:///actual-cache/' + key, size: 6}});
	for (const value of [null, [], {}, {id: '../source'}, {...f.ref, id: key + '\n'}, {...f.ref, size: -1}]) {
		await assert.rejects(f.chooser.restoreFile(value), code('INVALID_ARGUMENT'));
	}
	assert.equal(f.calls.length, 0);
	const saved = {...f.ref, uri: 'file:///do-not-trust/other', size: 1, name: 'saved-name', sourceUri: 'content://borrowed'};
	const file = await f.chooser.restoreFile(saved);
	assert.deepEqual(f.calls[0], {action: 'statFile', args: [key]});
	assert.equal(file.size, 6);
	assert.equal(file.uri, 'file:///actual-cache/' + key);
	assert.equal(file.name, 'saved-name');
	assert.equal(file.sourceUri, 'content://borrowed');
	assert.equal(Object.keys(file.toJSON()).some(name => typeof file.toJSON()[name] === 'function'), false);
	const badStat = fixture(undefined, {stat: {id: secondKey, uri: f.ref.uri, size: 3}});
	await assert.rejects(badStat.chooser.restoreFile(f.ref), code('FILE_UNAVAILABLE'));
	const incompleteStat = fixture(undefined, {stat: {id: key}});
	await assert.rejects(incompleteStat.chooser.restoreFile(f.ref), code('FILE_UNAVAILABLE'));
});

test('direct data stays busy through blocked reads and cleanup, and abort cancels source I/O before release', async () => {
	const calls = []; let settleRead, finishRelease;
	const chooser = loadChooser((ok, fail, service, action, args) => {
		calls.push({action, args: plain(args)});
		if (action === 'pick') ok({id: key, kind: 'source', name: 'file', mediaType: 'application/octet-stream', size: null});
		else if (action === 'readFile') settleRead = () => fail({code: 'READ_FAILED', message: 'closed on abort'});
		else if (action === 'releaseFile') finishRelease = ok;
		else ok();
	});
	const controller = new AbortController();
	const selected = chooser.getFileData({maxFileSize: null, format: 'bytes', signal: controller.signal});
	const rejected = assert.rejects(selected, error => error instanceof chooser.CancellationError && error.reason === 'signal');
	await tick();
	await assert.rejects(chooser.getFileMetadata(), code('BUSY'));
	controller.abort();
	await tick();
	assert.deepEqual(calls.filter(call => call.action === 'cancelRead').map(call => call.args), [[key]]);
	assert.equal(calls.some(call => call.action === 'releaseFile'), false);
	settleRead();
	await tick();
	assert.equal(typeof finishRelease, 'function');
	await assert.rejects(chooser.getFileMetadata(), code('BUSY'));
	finishRelease();
	await rejected;
});

test('native cleanup errors retain fulfilled values and recursively typed cancellation outcomes', async () => {
	for (const outcome of [{status: 'fulfilled', value: {receipt: 42}}, {status: 'rejected', reason: {code: 'CANCELLED', reason: 'picker'}}]) {
		const chooser = loadChooser((ok, fail) => fail({code: 'CLEANUP_FAILED', outcome, failures: [{id: key, error: {code: 'RELEASE_FAILED', message: 'locked'}}]}));
		await assert.rejects(chooser.getFileMetadata(), error => {
			assert.ok(error instanceof chooser.CleanupError);
			assert.equal(error.failures[0].id, key);
			assert.ok(error.failures[0].error instanceof chooser.ChooserError);
			if (outcome.status === 'fulfilled') assert.equal(error.outcome.value.receipt, 42);
			else { assert.ok(error.outcome.reason instanceof chooser.CancellationError); assert.equal(error.outcome.reason.reason, 'picker'); }
			return true;
		});
	}
});

test('aborted source reads retain native cleanup failures and still release every source', async () => {
	let failRead;
	const released = [];
	const chooser = loadChooser((ok, fail, service, action, args) => {
		if (action === 'pick') ok({id: key, kind: 'source', name: 'file', mediaType: 'application/octet-stream', size: null});
		else if (action === 'readFile') failRead = fail;
		else if (action === 'releaseFile') { released.push(args[0]); ok(); }
		else ok();
	});
	const controller = new AbortController();
	const selected = chooser.getFileData({maxFileSize: null, format: 'bytes', signal: controller.signal});
	const rejected = assert.rejects(selected, error => error instanceof chooser.CleanupError && error.outcome.reason instanceof chooser.CancellationError && error.failures[0].id === key);
	await tick();
	controller.abort();
	failRead({code: 'CLEANUP_FAILED', outcome: {status: 'rejected', reason: {code: 'CANCELLED', reason: 'signal'}}, failures: [{id: key, error: {code: 'RELEASE_FAILED', message: 'provider cleanup failed'}}]});
	await rejected;
	assert.deepEqual(released, [key]);
});

test('release removes a queued stream read without waiting for unrelated active native reads', async () => {
	const held = [], reads = [], released = [];
	const ref = id => ({id, uri: 'file:///cache/' + id, name: 'file', mediaType: 'application/octet-stream', size: 1});
	const chooser = loadChooser((ok, fail, service, action, args) => {
		if (action === 'statFile') ok(ref(args[0]));
		else if (action === 'readFile') {
			reads.push(args[0]);
			if (args[0] === key) held.push(() => ok({data: 'YQ==', eof: true}));
			else ok({data: 'Yg==', eof: true});
		}
		else if (action === 'releaseFile') { released.push(args[0]); ok(); }
	});
	const a = await chooser.restoreFile(ref(key));
	const b = await chooser.restoreFile(ref(secondKey));
	const active = Array.from({length: 4}, () => a.readRange({length: 1}));
	await tick();
	assert.equal(held.length, 4);
	const reader = b.stream().getReader();
	const stoppedRead = assert.rejects(reader.read(), code('FILE_RELEASED'));
	const stoppedReader = assert.rejects(reader.closed, code('FILE_RELEASED'));
	await tick();
	let releaseFinished = false;
	const releasing = b.release().then(() => { releaseFinished = true; });
	try {
		await stoppedRead; await stoppedReader;
		await tick();
		assert.equal(releaseFinished, true, 'B has no native I/O to await');
		assert.deepEqual(released, [secondKey]);
		assert.deepEqual(reads, Array(4).fill(key));
	}
	finally {
		held.splice(0).forEach(finish => finish());
		await Promise.all(active);
		await releasing;
	}
	await tick();
	assert.deepEqual(reads, Array(4).fill(key), 'the removed stream job must never dispatch later');
});

test('queued one-shot reads still finish before release while stream jobs can be removed', async () => {
	const held = [], released = [];
	const ref = id => ({id, uri: 'file:///cache/' + id, name: 'file', mediaType: 'application/octet-stream', size: 1});
	const chooser = loadChooser((ok, fail, service, action, args) => {
		if (action === 'statFile') ok(ref(args[0]));
		else if (action === 'readFile' && args[0] === key) held.push(() => ok({data: 'YQ==', eof: true}));
		else if (action === 'readFile') ok({data: 'Yg==', eof: true});
		else if (action === 'releaseFile') { released.push(args[0]); ok(); }
	});
	const a = await chooser.restoreFile(ref(key));
	const b = await chooser.restoreFile(ref(secondKey));
	const active = Array.from({length: 4}, () => a.bytes({maxBytes: null}));
	await tick();
	const queued = b.bytes({maxBytes: null});
	const releasing = b.release();
	await tick();
	assert.deepEqual(released, []);
	held.splice(0).forEach(finish => finish());
	assert.deepEqual(Array.from(await queued), [98]);
	await Promise.all(active);
	await releasing;
	assert.deepEqual(released, [secondKey]);
});

test('direct-data abort during held cleanup rejects after release and retains cleanup failures', async () => {
	for (const releaseFails of [false, true]) {
		let finishRelease;
		const calls = [];
		const chooser = loadChooser((ok, fail, service, action, args) => {
			calls.push(action);
			if (action === 'pick') ok({id: key, kind: 'source', name: 'file', mediaType: 'application/octet-stream', size: 99});
			else if (action === 'readFile') ok({data: 'YQ==', eof: true});
			else if (action === 'releaseFile') finishRelease = () => releaseFails ? fail({code: 'RELEASE_FAILED', message: 'locked'}) : ok();
			else ok();
		});
		const controller = new AbortController();
		const reason = new Error('cancel during cleanup');
		let settled = false;
		const result = chooser.getFileData({format: 'bytes', maxFileSize: null, signal: controller.signal});
		result.then(() => { settled = true; }, () => { settled = true; });
		const rejected = assert.rejects(result, error => {
			const cancellation = releaseFails ? error.outcome.reason : error;
			assert.ok(cancellation instanceof chooser.CancellationError);
			assert.equal(cancellation.reason, 'signal');
			assert.equal(cancellation.cause, reason);
			if (releaseFails) {
				assert.ok(error instanceof chooser.CleanupError);
				assert.equal(error.outcome.status, 'rejected');
				assert.equal(error.failures[0].id, key);
			}
			return true;
		});
		await tick();
		assert.equal(typeof finishRelease, 'function');
		controller.abort(reason);
		await tick();
		assert.equal(settled, false, 'cleanup must still finish before public settlement');
		await assert.rejects(chooser.getFileMetadata(), code('BUSY'));
		finishRelease();
		await rejected;
		assert.equal(calls.filter(action => action === 'releaseFile').length, 1);
	}
});

test('managed whole reads, ranges, and streams reject premature EOF against their authoritative size', async () => {
	const f = fixture(Buffer.from('a'), {recordedSize: 100});
	const file = await f.chooser.getFile({maxFileSize: null});
	for (const read of [
		() => file.bytes({maxBytes: null}),
		() => file.arrayBuffer({maxBytes: null}),
		() => file.blob({maxBytes: null}),
		() => file.text({maxBytes: null}),
		() => file.dataURI({maxBytes: null}),
		() => file.getData({format: 'bytesAndDataURI', maxBytes: null}),
		() => file.readRange({length: 100}),
		() => file.readRange({length: 1})
	]) await assert.rejects(read(), code('READ_FAILED'));
	for (const stream of [file.stream(), file.stream({length: 1}), file.textStream()]) {
		const reader = stream.getReader();
		await assert.rejects(reader.read(), code('READ_FAILED'));
	}
});

test('managed reads reject overrun and missing EOF while preserving valid short reads and EOF ranges', async () => {
	for (const options of [
		{recordedSize: 0},
		{recordedSize: 1, readResult: {data: 'YWI=', eof: true}},
		{recordedSize: 1, readResult: {data: 'YQ==', eof: false}}
	]) {
		const f = fixture(Buffer.from('a'), options);
		const file = await f.chooser.getFile({maxFileSize: null});
		await assert.rejects(file.bytes({maxBytes: null}), code('READ_FAILED'));
		await assert.rejects(file.readRange({length: 2}), code('READ_FAILED'));
		await assert.rejects(file.stream().getReader().read(), code('READ_FAILED'));
	}
	const f = fixture(Buffer.from('abcd'), {shortReads: 1});
	const file = await f.chooser.getFile({maxFileSize: null});
	assert.equal(Buffer.from(await file.bytes({maxBytes: null})).toString(), 'abcd');
	assert.equal(Buffer.from(await file.readRange({offset: 1, length: 2})).toString(), 'bc');
	assert.equal(Buffer.from(await file.readRange({offset: 3, length: 9})).toString(), 'd');
	assert.equal((await file.readRange({offset: 9, length: 2})).length, 0);
	assert.equal((await file.stream({offset: 9}).getReader().read()).done, true);
});

test('late abort during failed direct-data cleanup preserves the original read or decode failure', async () => {
	for (const originalCode of ['READ_FAILED', 'DECODE_FAILED']) {
		for (const releaseFails of [false, true]) {
			let finishRelease;
			const chooser = loadChooser((ok, fail, service, action) => {
				if (action === 'pick') ok({id: key, kind: 'source', name: 'file', mediaType: 'application/octet-stream', size: null});
				else if (action === 'readFile') {
					if (originalCode === 'READ_FAILED') fail({code: 'READ_FAILED', message: 'provider broke before abort'});
					else ok({data: '/w==', eof: true});
				}
				else if (action === 'releaseFile') finishRelease = () => releaseFails ? fail({code: 'RELEASE_FAILED', message: 'locked'}) : ok();
				else ok();
			});
			const controller = new AbortController();
			const result = chooser.getFileData({format: 'text', maxFileSize: null, signal: controller.signal});
			const rejected = assert.rejects(result, error => {
				const original = releaseFails ? error.outcome.reason : error;
				assert.equal(original.code, originalCode);
				if (releaseFails) {
					assert.ok(error instanceof chooser.CleanupError);
					assert.equal(error.outcome.status, 'rejected');
					assert.equal(error.failures[0].id, key);
				}
				return true;
			});
			await tick();
			assert.equal(typeof finishRelease, 'function');
			controller.abort();
			finishRelease();
			await rejected;
		}
	}
});

test('native failures frozen before native cleanup are not replaced by a later signal abort', async () => {
	for (const cleanupFailed of [false, true]) {
		let finishPick;
		const chooser = loadChooser((ok, fail, service, action) => {
			if (action === 'pick') finishPick = fail;
			else ok();
		});
		const controller = new AbortController();
		const result = chooser.getFileData({format: 'bytes', maxFileSize: null, signal: controller.signal});
		const rejected = assert.rejects(result, error => {
			const original = cleanupFailed ? error.outcome.reason : error;
			assert.equal(original.code, 'READ_FAILED');
			if (cleanupFailed) {
				assert.ok(error instanceof chooser.CleanupError);
				assert.equal(error.failures[0].id, key);
			}
			return true;
		});
		controller.abort();
		const failure = {code: 'READ_FAILED', message: 'failure established before abort'};
		finishPick(cleanupFailed ? {code: 'CLEANUP_FAILED', outcome: {status: 'rejected', reason: failure}, failures: [{id: key, error: {code: 'RELEASE_FAILED'}}]} : failure);
		await rejected;
	}
});
