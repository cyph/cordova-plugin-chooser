const test = require('node:test');
const assert = require('node:assert/strict');
const {loadChooser} = require('./helpers');

const id = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const plain = value => JSON.parse(JSON.stringify(value));
const info = {name: 'sample.bin', mediaType: 'application/octet-stream', size: null, sourceUri: 'content://fixture/source'};
const reference = (n = 1, size = 3) => ({...info, id: id(n), size, uri: 'file:///cache/' + id(n)});
const code = expected => error => error.code === expected;
const tick = () => new Promise(setImmediate);

function fixture(input = [Buffer.from('abc')], options = {}) {
	const calls = [], released = [], readers = new Map();
	const chooser = loadChooser((ok, fail, service, action, args) => {
		assert.equal(service, 'Chooser');
		calls.push({action, args: plain(args)});
		if (action === 'pick') {
			const wire = args[0];
			const results = input.map((bytes, index) => {
				const metadata = {...info, name: 'file-' + index, size: options.reportedSize ?? null};
				if (wire.mode === 'metadata') return metadata;
				readers.set(id(index + 1), {bytes, position: 0, source: wire.mode === 'data'});
				return wire.mode === 'copy' ? {...reference(index + 1, bytes.length), name: metadata.name} : {...metadata, id: id(index + 1), kind: 'source'};
			});
			ok(JSON.stringify(wire.multiple ? results : results[0]));
		}
		else if (action === 'readFile') {
			const [key, offset, length] = args;
			assert.ok(length <= 262144);
			const reader = readers.get(key);
			assert.ok(reader, 'read after release');
			if (reader.source) assert.equal(offset, reader.position, 'transient source reads must be sequential');
			const chunk = reader.bytes.subarray(offset, offset + Math.min(length, options.shortReads || length));
			reader.position += chunk.length;
			const base64 = options.encode ? options.encode(chunk) : chunk.toString('base64');
			ok({data: base64, eof: offset + chunk.length >= reader.bytes.length});
		}
		else if (action === 'releaseFile') {
			released.push(args[0]);
			if (options.releaseFailure) fail({code: 'RELEASE_FAILED', message: 'locked'});
			else { readers.delete(args[0]); ok(); }
		}
		else throw new Error('Unexpected action ' + action);
	});
	return {chooser, calls, released, readers};
}

test('managed selection dispatches synchronously, normalizes filters, and returns only a reference', async () => {
	const f = fixture();
	const pending = f.chooser.getFile({accept: [' IMAGE/PNG ', 'text/*', 'image/png'], maxFileSize: null, localOnly: true});
	assert.equal(f.calls.length, 1, 'dispatch must stay in the browser gesture');
	const wire = f.calls[0].args[0];
	assert.equal(wire.mode, 'copy');
	assert.equal(wire.source, 'documents');
	assert.equal(wire.accept, 'image/png,text/*');
	assert.equal(wire.maxFileSize, 0);
	assert.equal(wire.maxTotalSize, 0);
	assert.equal(wire.localOnly, true);
	assert.equal(typeof wire.requestId, 'string');
	const file = await pending;
	assert.equal(file.id, id(1));
	assert.equal(typeof file.bytes, 'function');
	assert.equal('data' in file, false);
	assert.deepEqual(plain(file), {...reference(), name: 'file-0'});
});

test('metadata methods return no managed resources and never read or release content', async () => {
	const f = fixture();
	assert.equal((await f.chooser.getFileMetadata()).size, null);
	const files = await f.chooser.getFilesMetadata({source: 'photos', mediaTypes: ['video'], maxFiles: null});
	assert.equal(files.length, 1);
	assert.equal('id' in files[0], false);
	assert.equal('uri' in files[0], false);
	assert.deepEqual(f.calls.map(call => call.action), ['pick', 'pick']);
	assert.deepEqual(f.calls[1].args[0].mediaTypes, ['video']);
	assert.equal(f.calls[1].args[0].multiple, true);
});

test('strict public options reject before dispatch, including every callback overload', async () => {
	let calls = 0;
	const chooser = loadChooser(() => { calls++; });
	for (const options of [undefined, null, [], 'text/plain', {}, new Date(), {maxFileSize: 0}, {maxFileSize: -1},
		{maxFileSize: 1.5}, {maxFileSize: Infinity}, {maxFileSize: NaN}, {maxFileSize: Number.MAX_SAFE_INTEGER + 1},
		{maxFileSize: '10'}, {maxFileSize: null, maxFilesize: 1}, {maxFileSize: null, mimeTypes: 'text/csv'},
		{maxFileSize: null, accept: ''}, {maxFileSize: null, accept: []}, {maxFileSize: null, accept: ['text/plain', 1]},
		{maxFileSize: null, source: 'camera'}, {maxFileSize: null, mediaTypes: ['image']},
		{maxFileSize: null, source: 'photos', accept: 'image/*'}, {maxFileSize: null, source: 'photos', localOnly: false},
		{maxFileSize: null, source: 'photos', mediaTypes: []}, {maxFileSize: null, source: 'photos', mediaTypes: ['audio']},
		{maxFileSize: null, localOnly: 1}, {maxFileSize: null, signal: {}}, {maxFileSize: null, cancel: 'return'}]) {
		await assert.rejects(chooser.getFile(options), code('INVALID_ARGUMENT'));
	}
	for (const method of ['getFile', 'getFiles', 'getFileData', 'getFilesData', 'getFileMetadata', 'getFilesMetadata']) {
		await assert.rejects(chooser[method]({}, () => {}), code('INVALID_ARGUMENT'));
		await assert.rejects(chooser[method](() => {}), code('INVALID_ARGUMENT'));
	}
	for (const options of [{maxFileSize: null}, {maxFileSize: null, maxTotalSize: 0}, {maxFileSize: null, maxTotalSize: null, maxFiles: 0}]) {
		await assert.rejects(chooser.getFiles(options), code('INVALID_ARGUMENT'));
	}
	for (const options of [{maxFileSize: null}, {maxFileSize: null, format: 'csv'}, {maxFileSize: null, format: 'bytes', decoding: {fatal: false}}]) {
		await assert.rejects(chooser.getFileData(options), code('INVALID_ARGUMENT'));
	}
	await assert.rejects(chooser.getFileMetadata({maxFileSize: 1}), code('INVALID_ARGUMENT'));
	await assert.rejects(chooser.releaseFile(id(1), () => {}), code('INVALID_ARGUMENT'));
	assert.equal(calls, 0);
	assert.equal(chooser.getFileUri, undefined);
});

test('plural selection preserves array shape and explicit budgets', async () => {
	const f = fixture();
	const files = await f.chooser.getFiles({maxFileSize: 4, maxTotalSize: 8, maxFiles: 2, source: 'photos'});
	assert.ok(Array.isArray(files));
	assert.equal(files.length, 1);
	assert.deepEqual(f.calls[0].args[0].mediaTypes, ['image', 'video']);
	assert.equal(f.calls[0].args[0].maxFiles, 2);
	assert.equal(f.calls[0].args[0].maxTotalSize, 8);
});

test('picker dismissal, structured failures, and prefixed native errors have stable typed errors', async () => {
	for (const response of ['RESULT_CANCELED', {code: 'CANCELLED', reason: 'picker', message: 'cancel'}]) {
		const chooser = loadChooser((ok, fail) => typeof response === 'string' ? ok(response) : fail(response));
		await assert.rejects(chooser.getFileMetadata(), error => error instanceof chooser.CancellationError && error.code === 'CANCELLED' && error.reason === 'picker');
	}
	const chooser = loadChooser((ok, fail) => fail('PERMISSION_DENIED: blocked'));
	await assert.rejects(chooser.getFileMetadata(), error => error instanceof chooser.ChooserError && error.code === 'PERMISSION_DENIED' && error.message === 'blocked');
});

test('already-aborted signals dispatch nothing and preserve their cancellation cause', async () => {
	let calls = 0;
	const chooser = loadChooser(() => { calls++; });
	const controller = new AbortController();
	const reason = new Error('stop');
	controller.abort(reason);
	await assert.rejects(chooser.getFile({maxFileSize: null, signal: controller.signal}), error => error instanceof chooser.CancellationError && error.reason === 'signal' && error.cause === reason);
	assert.equal(calls, 0);
});

test('abort waits for original pick settlement, rolls back late resources, and blocks overlapping pickers', async () => {
	const calls = []; let finish;
	const chooser = loadChooser((ok, fail, service, action, args) => {
		calls.push({action, args: plain(args)});
		if (action === 'pick') finish = ok;
		else ok();
	});
	const controller = new AbortController();
	const pending = chooser.getFile({maxFileSize: null, signal: controller.signal});
	let settled = false;
	pending.then(() => { settled = true; }, () => { settled = true; });
	controller.abort();
	await tick();
	assert.equal(settled, false);
	assert.equal(calls[1].action, 'cancelPick');
	assert.equal(calls[1].args[0], calls[0].args[0].requestId);
	await assert.rejects(chooser.getFileMetadata(), code('BUSY'));
	finish(reference());
	await assert.rejects(pending, error => error instanceof chooser.CancellationError && error.reason === 'signal');
	assert.equal(calls.at(-1).action, 'releaseFile');
	const reopened = chooser.getFileMetadata();
	finish(info);
	assert.equal((await reopened).name, info.name);
});

test('late duplicate callbacks cannot settle a newer picker or release an accepted resource', async () => {
	const pending = [], releases = [];
	const chooser = loadChooser((ok, fail, service, action, args) => {
		if (action === 'pick') pending.push({ok, fail});
		else if (action === 'releaseFile') { releases.push(args[0]); ok(); }
	});
	const first = chooser.getFile({maxFileSize: null});
	pending[0].ok(reference());
	await first;
	const second = chooser.getFileMetadata();
	pending[0].fail('old failure');
	pending[0].ok(reference());
	pending[1].ok(info);
	assert.equal((await second).name, info.name);
	assert.equal(releases.length, 0);
});

test('direct formats read a transient source and always release it, including empty files', async () => {
	for (const format of ['bytes', 'text', 'dataURI', 'bytesAndDataURI']) {
		for (const bytes of [Buffer.alloc(0), Buffer.from('hello')]) {
			const f = fixture([bytes]);
			const result = await f.chooser.getFileData({maxFileSize: null, format});
			assert.equal(result.size, bytes.length);
			assert.equal(result.format, format);
			assert.equal('id' in result, false);
			assert.equal('uri' in result, false);
			if (format === 'bytes' || format === 'bytesAndDataURI') assert.deepEqual(Buffer.from(result.data), bytes);
			if (format === 'text') assert.equal(result.text, bytes.toString());
			if (format === 'dataURI' || format === 'bytesAndDataURI') assert.equal(result.dataURI, 'data:application/octet-stream;base64,' + bytes.toString('base64'));
			assert.deepEqual(f.released, [id(1)]);
			assert.equal(f.readers.size, 0);
		}
	}
});

test('padded, unpadded, and wrapped base64 preserve bytes and canonical padding', async () => {
	for (let length = 0; length < 260; length++) {
		const bytes = Buffer.from(Array.from({length}, (_, i) => (i * 37 + length) & 255));
		for (const encode of [b => b.toString('base64'), b => b.toString('base64').replace(/=+$/, ''), b => b.toString('base64').replace(/(.{8})/g, '$1\r\n')]) {
			const f = fixture([bytes], {encode});
			const result = await f.chooser.getFileData({maxFileSize: null, format: 'bytesAndDataURI'});
			assert.deepEqual(Buffer.from(result.data), bytes);
			assert.equal(result.dataURI.split(',')[1], bytes.toString('base64'));
		}
	}
});

test('direct sources honor actual byte and aggregate budgets even when metadata lies', async () => {
	for (const reportedSize of [0, 999999]) {
		const f = fixture([Buffer.from('abcd')], {reportedSize, shortReads: 2});
		await assert.rejects(f.chooser.getFileData({maxFileSize: 3, format: 'bytes'}), code('FILE_TOO_LARGE'));
		assert.deepEqual(f.released, [id(1)]);
	}
	const exact = fixture([Buffer.from('ab'), Buffer.from('cd')]);
	assert.equal((await exact.chooser.getFilesData({maxFileSize: 2, maxTotalSize: 4, format: 'text'})).length, 2);
	const exceeds = fixture([Buffer.from('ab'), Buffer.from('cd')]);
	await assert.rejects(exceeds.chooser.getFilesData({maxFileSize: 2, maxTotalSize: 3, format: 'bytes'}), code('TOTAL_SIZE_EXCEEDED'));
	assert.deepEqual(exceeds.released.sort(), [id(1), id(2)]);
});

test('read/decode failures release every transient source and malformed results do not silently corrupt data', async () => {
	for (const malformed of ['A', 'AA=', 'AA===', 'A!AA', 'AB==', 'AAB=']) {
		const f = fixture([Buffer.from('x')], {encode: () => malformed});
		await assert.rejects(f.chooser.getFileData({maxFileSize: null, format: 'bytes'}), code('READ_FAILED'));
		assert.deepEqual(f.released, [id(1)]);
	}
	const f = fixture([Buffer.from([0xff]), Buffer.from('unused')]);
	await assert.rejects(f.chooser.getFilesData({maxFileSize: null, maxTotalSize: null, format: 'text'}), code('DECODE_FAILED'));
	assert.deepEqual(f.released.sort(), [id(1), id(2)]);
	const replacement = fixture([Buffer.from([0xff])]);
	assert.equal((await replacement.chooser.getFileData({maxFileSize: null, format: 'text', decoding: {fatal: false}})).text, '\ufffd');
});

test('invalid selections roll back all recognizable resources', async () => {
	for (const response of [[], [reference(), {...reference(2), size: -1}], [reference(), reference()], [reference(), reference(2)]]) {
		const released = [];
		const chooser = loadChooser((ok, fail, service, action, args) => {
			if (action === 'pick') ok(response);
			else { released.push(args[0]); ok(); }
		});
		await assert.rejects(chooser.getFiles({maxFileSize: null, maxTotalSize: null, maxFiles: 1}));
		assert.deepEqual(released.sort(), [...new Set(response.map(file => file.id))].sort());
	}
	for (const response of ['not json', null, {}, []]) {
		await assert.rejects(loadChooser(ok => ok(response)).getFileMetadata());
	}
});

test('scoped helpers preserve fulfilled values and original exceptions while attempting cleanup', async () => {
	for (const failCleanup of [false, true]) {
		const f = fixture(undefined, {releaseFailure: failCleanup});
		const value = {uploaded: true, receipt: 42};
		const result = f.chooser.withFile({maxFileSize: null}, async file => { assert.equal(file.id, id(1)); return value; });
		if (failCleanup) await assert.rejects(result, error => error instanceof f.chooser.CleanupError && error.outcome.status === 'fulfilled' && error.outcome.value === value && error.failures[0].id === id(1));
		else assert.equal(await result, value);
		assert.deepEqual(f.released, [id(1)]);
		const failed = fixture(undefined, {releaseFailure: failCleanup});
		const original = new Error('upload failed');
		await assert.rejects(failed.chooser.withFile({maxFileSize: null}, () => { throw original; }), error => failCleanup ? error instanceof failed.chooser.CleanupError && error.outcome.reason === original : error === original);
	}
});

test('direct-data cleanup failure retains the successful result and explicit retry IDs', async () => {
	const f = fixture(undefined, {releaseFailure: true});
	await assert.rejects(f.chooser.getFileData({maxFileSize: null, format: 'text'}), error => error instanceof f.chooser.CleanupError && error.outcome.status === 'fulfilled' && error.outcome.value.text === 'abc' && error.failures[0].id === id(1));
	assert.deepEqual(f.released, [id(1)]);
});

test('cancellation never hides a cleanup failure', async () => {
	let finish;
	const chooser = loadChooser((ok, fail, service, action) => {
		if (action === 'pick') finish = ok;
		else if (action === 'releaseFile') fail({code: 'RELEASE_FAILED', message: 'locked'});
		else ok();
	});
	const controller = new AbortController();
	const result = chooser.getFile({maxFileSize: null, signal: controller.signal});
	controller.abort();
	finish(reference());
	await assert.rejects(result, error => error instanceof chooser.CleanupError && error.outcome.reason instanceof chooser.CancellationError && error.failures[0].id === id(1));
});

test('scoped consumer owns its lifetime after selection; later signal cancellation cannot delete underneath it', async () => {
	const f = fixture();
	const controller = new AbortController();
	let finish;
	const result = f.chooser.withFile({maxFileSize: null, signal: controller.signal}, () => new Promise(resolve => { finish = resolve; }));
	await tick();
	controller.abort();
	await tick();
	assert.deepEqual(f.released, []);
	assert.equal(f.calls.some(call => call.action === 'cancelPick'), false);
	finish(undefined);
	assert.equal(await result, undefined);
	assert.deepEqual(f.released, [id(1)]);
});

test('scoped plural cleanup retains ownership when a JavaScript consumer mutates its selection array', async () => {
	const f = fixture([Buffer.from('one'), Buffer.from('two')]);
	const result = await f.chooser.withFiles({maxFileSize: null, maxTotalSize: null}, files => {
		files.splice(0, files.length);
		return 'uploaded';
	});
	assert.equal(result, 'uploaded');
	assert.deepEqual(f.released.sort(), [id(1), id(2)]);
});

test('transient source reads ignore both overestimated and underestimated provider sizes', async () => {
	for (const reportedSize of [0, 1, 100]) {
		const f = fixture([Buffer.from('abc')], {reportedSize});
		const value = await f.chooser.getFileData({format: 'bytes', maxFileSize: null});
		assert.equal(value.size, 3);
		assert.equal(Buffer.from(value.data).toString(), 'abc');
		assert.deepEqual(f.released, [id(1)]);
	}
});
