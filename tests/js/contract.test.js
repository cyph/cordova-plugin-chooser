const test = require('node:test');
const assert = require('node:assert/strict');
const {loadChooser} = require('./helpers');

const plain = value => JSON.parse(JSON.stringify(value));
const metadata = {name: 'sample.bin', uri: 'content://fixture/1', mediaType: 'application/octet-stream', size: null};

test('legacy methods preserve bridge arguments, Promise results and callback overloads', async () => {
	const calls = [];
	const chooser = loadChooser((ok, fail, service, action, args) => {
		calls.push({service, action, args: plain(args)});
		ok(JSON.stringify({...metadata, data: 'YQ=='}));
	});
	const file = await chooser.getFile(' IMAGE/PNG, text/* ');
	assert.deepEqual(Array.from(file.data), [97]);
	assert.equal(file.dataURI, 'data:application/octet-stream;base64,YQ==');
	let fromCallback;
	const promise = chooser.getFileMetadata(value => { fromCallback = value; });
	const info = await promise;
	assert.equal(fromCallback, info);
	assert.equal('data' in info, false);
	assert.equal('dataURI' in info, false);
	assert.deepEqual(calls, [
		{service: 'Chooser', action: 'getFile', args: ['image/png,text/*', true]},
		{service: 'Chooser', action: 'getFile', args: ['*/*', false]}
	]);
});

test('padded, unpadded and wrapped base64 preserve every byte, including empty files', async () => {
	for (let length = 0; length < 260; length++) {
		const bytes = Buffer.from(Array.from({length}, (_, i) => (i * 37 + length) & 255));
		const canonical = bytes.toString('base64');
		for (const data of [canonical, canonical.replace(/=+$/, ''), canonical.replace(/(.{8})/g, '$1\r\n')]) {
			const chooser = loadChooser(ok => ok(JSON.stringify({...metadata, data})));
			const file = await chooser.getFile();
			assert.deepEqual(Array.from(file.data), Array.from(bytes));
			assert.equal(file.dataURI, 'data:application/octet-stream;base64,' + canonical);
		}
	}
});

test('malformed responses reject instead of silently corrupting data', async () => {
	for (const response of ['not-json', 'null', '[]', '{}', ...['A', 'AA=', 'AA===', 'A!AA', 'AB==', 'AAB='].map(data => JSON.stringify({...metadata, data}))]) {
		await assert.rejects(loadChooser(ok => ok(response)).getFile());
	}
});

test('cancellation settles to undefined and invokes success once', async () => {
	let callbackCount = 0;
	const chooser = loadChooser(ok => { ok('RESULT_CANCELED'); ok(JSON.stringify({...metadata, data: ''})); });
	assert.equal(await chooser.getFile(() => { callbackCount++; }), undefined);
	assert.equal(callbackCount, 1);
});

test('failure callbacks and returned rejections agree without a detached rejection', async () => {
	let failure;
	const chooser = loadChooser((ok, fail) => fail('provider failure'));
	await assert.rejects(chooser.getFile(() => {}, error => { failure = error; }), error => error === 'provider failure');
	assert.equal(failure, 'provider failure');
});

test('callback exceptions are reported separately from the selected file', async () => {
	const timers = [];
	const chooser = loadChooser(ok => ok(JSON.stringify({...metadata, data: ''})), timers);
	const expected = new Error('callback error');
	const file = await chooser.getFile(() => { throw expected; });
	assert.equal(file.name, metadata.name);
	assert.equal(timers.length, 1);
	assert.throws(timers[0], error => error === expected);
	await chooser.getFile(async () => { throw expected; });
	await new Promise(setImmediate);
	assert.equal(timers.length, 2);
});

test('new methods preserve array shape and distinguish copy mode from data', async () => {
	const calls = [];
	const chooser = loadChooser((ok, fail, service, action, args) => {
		calls.push({action, options: plain(args[0])});
		const file = {...metadata, data: 'AA==', id: '00000000-0000-4000-8000-000000000001', size: 1};
		ok(JSON.stringify(args[0].multiple ? [file] : file));
	});
	assert.equal((await chooser.getFiles())[0].data.byteLength, 1);
	assert.equal('data' in (await chooser.getFilesMetadata())[0], false);
	const copy = await chooser.getFileUri({accept: ' TEXT/PLAIN ', maxFileSize: 42, localOnly: true});
	assert.equal('data' in copy, false);
	await chooser.getFilesUri();
	assert.deepEqual(calls.map(x => [x.action, x.options.mode, x.options.multiple]), [
		['pick', 'data', true], ['pick', 'metadata', true], ['pick', 'copy', false], ['pick', 'copy', true]
	]);
	assert.equal(calls[2].options.maxFileSize, 42);
	assert.equal(calls[2].options.accept, 'text/plain');
	assert.equal(calls[2].options.localOnly, true);
	assert.equal(calls[3].options.maxFileSize, 0);
});

test('invalid copy options and foreign release identifiers never reach native code', async () => {
	let calls = 0;
	const chooser = loadChooser(() => { calls++; });
	for (const maxFileSize of [-1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '10', true]) {
		await assert.rejects(chooser.getFileUri({maxFileSize}));
	}
	for (const options of [[], 2, {localOnly: 'yes'}, {accept: 1}]) await assert.rejects(chooser.getFileUri(options));
	for (const id of ['../source', 'file:///private/source', '', '00000000-0000-4000-8000-000000000001\n']) {
		await assert.rejects(chooser.releaseFile(id));
	}
	assert.equal(calls, 0);
});

test('release returns void and supports both callbacks and Promises', async () => {
	let callbackCount = 0;
	const chooser = loadChooser((ok, fail, service, action, args) => {
		assert.equal(action, 'releaseFile');
		assert.equal(args[0], '00000000-0000-4000-8000-000000000001');
		ok('');
	});
	assert.equal(await chooser.releaseFile('00000000-0000-4000-8000-000000000001', () => { callbackCount++; }), undefined);
	assert.equal(callbackCount, 1);
});
