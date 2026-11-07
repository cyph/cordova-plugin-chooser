const test = require('node:test');
const assert = require('node:assert/strict');
const {browserFixture} = require('./helpers');

function file(name = 'a.bin', bytes = [0, 1, 255], type = 'application/octet-stream') {
	const blob = new Blob([Uint8Array.from(bytes)], {type});
	const reads = [];
	return {name, size: blob.size, type, reads, slice(start, end) {
		reads.push([start, end]);
		return blob.slice(start, end);
	}};
}
const code = expected => error => error.code === expected;
async function select(fixture, method, options, files) {
	const pending = fixture.chooser[method](options);
	fixture.elements.at(-1).emit('change', files);
	return pending;
}

test('direct combined data opens synchronously, reads once, and owns no Blob URL', async () => {
	const f = browserFixture(), input = file();
	const pending = f.chooser.getFileData({accept: 'image/*', maxFileSize: 3, format: 'bytesAndDataURI'});
	assert.equal(f.elements[0].clicked, true);
	assert.equal(f.elements[0].accept, 'image/*');
	f.elements[0].emit('change', [input]);
	const result = await pending;
	assert.deepEqual(Array.from(result.data), [0, 1, 255]);
	assert.equal(result.dataURI, 'data:application/octet-stream;base64,AAH/');
	assert.equal(input.reads.length, 1);
	assert.equal('id' in result, false);
	assert.equal(f.blobs.size, 0);
	assert.equal(f.elements[0].attached, false);
});

test('metadata has no reads or owned resources; managed handles read and restore by ID', async () => {
	const f = browserFixture(), input = file();
	const info = await select(f, 'getFileMetadata', undefined, [input]);
	assert.equal(info.name, 'a.bin');
	assert.equal('id' in info, false);
	assert.equal('uri' in info, false);
	assert.equal(input.reads.length, 0);
	const managed = await select(f, 'getFile', {maxFileSize: 3}, [input]);
	assert.equal(input.reads.length, 0);
	const restored = await f.chooser.restoreFile(JSON.parse(JSON.stringify(managed)));
	assert.deepEqual(Array.from(await restored.read({offset: 1, length: 20})), [1, 255]);
	await managed.release();
	await assert.rejects(restored.bytes({maxBytes: 3}), code('FILE_RELEASED'));
	await restored.release();
	assert.equal(f.blobs.size, 0);
});

test('native input cancellation, empty selection and AbortSignal use cancellation exceptions', async () => {
	const f = browserFixture();
	const canceled = f.chooser.getFile({maxFileSize: null});
	const rejected = assert.rejects(canceled, error => error instanceof f.chooser.CancellationError && error.reason === 'picker');
	f.elements[0].emit('cancel');
	await rejected;
	const empty = f.chooser.getFilesMetadata();
	const emptyRejected = assert.rejects(empty, code('CANCELLED'));
	f.elements[1].emit('change', []);
	await emptyRejected;
	const controller = new AbortController();
	const aborted = f.chooser.getFileMetadata({signal: controller.signal});
	const signalRejected = assert.rejects(aborted, error => error.code === 'CANCELLED' && error.reason === 'signal');
	controller.abort();
	await signalRejected;
	const next = await select(f, 'getFileMetadata', undefined, [file('next')]);
	assert.equal(next.name, 'next');
	assert.equal(f.blobs.size, 0);
});

test('a concurrent request cannot steal the picker callback', async () => {
	const f = browserFixture();
	const pending = f.chooser.getFileMetadata();
	await assert.rejects(f.chooser.getFileMetadata(), code('BUSY'));
	f.elements[0].emit('change', [file('original')]);
	assert.equal((await pending).name, 'original');
});

test('failed batches roll back earlier URLs and limits apply to data and metadata count', async () => {
	const f = browserFixture();
	for (const method of ['getFiles', 'getFilesData']) {
		const pending = f.chooser[method]({maxFileSize: 2, maxTotalSize: 20, ...(method === 'getFilesData' ? {format: 'bytes'} : {})});
		const rejection = assert.rejects(pending, code('FILE_TOO_LARGE'));
		f.elements.at(-1).emit('change', [file('small', [1]), file('large')]);
		await rejection;
		assert.equal(f.blobs.size, 0);
	}
	const pending = f.chooser.getFilesMetadata({maxFiles: 1});
	const rejection = assert.rejects(pending, code('TOO_MANY_FILES'));
	f.elements.at(-1).emit('change', [file(), file('second')]);
	await rejection;
});

test('aggregate budgets allow exact boundaries and empty files', async () => {
	const f = browserFixture();
	const kept = await select(f, 'getFiles', {maxTotalSize: 3, maxFileSize: 2, maxFiles: 3}, [file('one', [1]), file('two', [2, 3]), file('empty', [])]);
	assert.equal(kept.length, 3);
	assert.equal((await kept[2].bytes({maxBytes: 1})).length, 0);
	const pending = f.chooser.getFiles({maxFileSize: null, maxTotalSize: 3});
	const rejected = assert.rejects(pending, code('TOTAL_SIZE_EXCEEDED'));
	f.elements.at(-1).emit('change', [file(), file('excess', [4])]);
	await rejected;
	assert.equal(f.blobs.size, 3);
	await f.chooser.releaseFiles(kept.map(item => item.id));
	assert.equal(f.blobs.size, 0);
});

test('Photos selects image/video inputs and streams decode across chunk boundaries', async () => {
	const f = browserFixture();
	const pending = f.chooser.getFile({source: 'photos', mediaTypes: ['video'], maxFileSize: null});
	assert.equal(f.elements[0].accept, 'video/*');
	const bytes = new TextEncoder().encode('x'.repeat(262143) + '€tail');
	const input = file('clip.txt', bytes, 'text/plain');
	f.elements[0].emit('change', [input]);
	const managed = await pending;
	const reader = managed.textStream().getReader();
	let text = '';
	for (let part; !(part = await reader.read()).done;) text += part.value;
	assert.equal(text, 'x'.repeat(262143) + '€tail');
	assert(input.reads.every(([start, end]) => end - start <= 262144));
	await managed.release();
});

test('read failures release direct sources and allow another selection', async () => {
	const f = browserFixture(), broken = file();
	broken.slice = () => ({arrayBuffer: async () => { throw new Error('fixture read failure'); }});
	const pending = f.chooser.getFileData({maxFileSize: 3, format: 'bytes'});
	const rejected = assert.rejects(pending, code('READ_FAILED'));
	f.elements[0].emit('change', [broken]);
	await rejected;
	assert.equal(f.blobs.size, 0);
	assert.equal((await select(f, 'getFileMetadata', undefined, [file('next')])).name, 'next');
});

test('pagehide revokes live URLs and saved browser references cannot revive them', async () => {
	const f = browserFixture();
	const managed = await select(f, 'getFile', {maxFileSize: null}, [file()]);
	const reference = managed.toJSON();
	f.pagehide();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.blobs.size, 0);
	await assert.rejects(f.chooser.restoreFile(reference), code('FILE_UNAVAILABLE'));
});
