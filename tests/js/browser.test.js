const test = require('node:test');
const assert = require('node:assert/strict');
const {browserFixture} = require('./helpers');

const file = (name = 'a.bin', bytes = [0, 1, 255]) => ({name, bytes, size: bytes.length, type: 'application/octet-stream'});

test('browser bridge reads binary once and opens the input in the calling gesture', async () => {
	const f = browserFixture();
	const promise = f.chooser.getFile('image/*');
	assert.equal(f.elements[0].clicked, true);
	assert.equal(f.elements[0].accept, 'image/*');
	const changed = f.elements[0].emit('change', [file()]);
	f.readers[0].complete();
	await changed;
	const selected = await promise;
	assert.deepEqual(Array.from(selected.data), [0, 1, 255]);
	assert.equal(f.elements[0].attached, false);
	assert.equal(f.blobs.size, 1);
	await f.chooser.releaseFile(selected.id);
	assert.equal(f.blobs.size, 0);
});

test('metadata and copy mode do not start FileReader; managed IDs remain independently releasable', async () => {
	const f = browserFixture();
	const first = f.chooser.getFileMetadata();
	await f.elements[0].emit('change', [file()]);
	const info = await first;
	const second = f.chooser.getFilesUri({maxFileSize: 3});
	await f.elements[1].emit('change', [file(), file('b.bin')]);
	const copies = await second;
	assert.equal(copies.length, 2);
	assert.equal(f.elements[1].multiple, true);
	assert.equal(f.readers.length, 0);
	assert.equal(f.blobs.size, 3);
	await f.chooser.releaseFile(copies[0].id);
	await f.chooser.releaseFile(copies[0].id);
	assert.equal(f.blobs.size, 2);
	assert.equal('data' in info, false);
	f.pagehide();
	assert.equal(f.blobs.size, 0);
});

test('both native input cancellation and an empty selection resolve undefined', async () => {
	const f = browserFixture();
	const canceled = f.chooser.getFile();
	f.elements[0].emit('cancel');
	assert.equal(await canceled, undefined);
	const empty = f.chooser.getFiles();
	await f.elements[1].emit('change', []);
	assert.equal(await empty, undefined);
	assert.equal(f.blobs.size, 0);
});

test('a concurrent request fails without stealing the original callback', async () => {
	const f = browserFixture();
	const pending = f.chooser.getFileMetadata();
	await assert.rejects(f.chooser.getFileMetadata(), value => value.startsWith('BUSY:'));
	await f.elements[0].emit('change', [file('original')]);
	assert.equal((await pending).name, 'original');
});

test('failed copy batches revoke earlier results and a later unlimited call is independent', async () => {
	const f = browserFixture();
	const limited = f.chooser.getFilesUri({maxFileSize: 2});
	const rejection = assert.rejects(limited, value => value.startsWith('FILE_TOO_LARGE:'));
	await f.elements[0].emit('change', [file('small', [1]), file('large')]);
	await rejection;
	assert.equal(f.blobs.size, 0);
	const unlimited = f.chooser.getFileUri();
	await f.elements[1].emit('change', [file()]);
	assert.equal((await unlimited).size, 3);
});

test('read errors and page reset clean partial URLs and do not affect the next request', async () => {
	const f = browserFixture();
	const failed = f.chooser.getFile();
	const rejection = assert.rejects(failed, value => value.startsWith('READ_FAILED:'));
	const change = f.elements[0].emit('change', [file()]);
	f.readers[0].fail();
	await change;
	await rejection;
	assert.equal(f.blobs.size, 0);
	const reset = f.chooser.getFile();
	const reading = f.elements[1].emit('change', [file()]);
	f.pagehide();
	assert.equal(await reset, undefined);
	await reading;
	const next = f.chooser.getFileMetadata();
	await f.elements[2].emit('change', [file('next')]);
	assert.equal((await next).name, 'next');
	assert.equal(f.blobs.size, 1);
});

test('copy count limits reject before creating resources', async () => {
	const f = browserFixture();
	const pending = f.chooser.getFilesUri({maxFiles: 1});
	const rejection = assert.rejects(pending, error => error.startsWith('TOO_MANY_FILES:'));
	await f.elements[0].emit('change', [file(), file('second')]);
	await rejection;
	assert.equal(f.blobs.size, 0);
	assert.equal(f.readers.length, 0);
	const single = f.chooser.getFileUri({maxFiles: 1});
	await f.elements[1].emit('change', [file(), file('ignored')]);
	assert.equal((await single).name, 'a.bin');
});

test('aggregate budgets permit exact totals and empty files, then roll back on the first excess byte', async () => {
	const f = browserFixture();
	const exact = f.chooser.getFilesUri({maxTotalSize: 3, maxFileSize: 2, maxFiles: 3});
	await f.elements[0].emit('change', [file('one', [1]), file('two', [2, 3]), file('empty', [])]);
	const kept = await exact;
	assert.equal(kept.length, 3);
	const exceeded = f.chooser.getFilesUri({maxTotalSize: 3});
	const rejection = assert.rejects(exceeded, error => error.startsWith('TOTAL_SIZE_EXCEEDED:'));
	await f.elements[1].emit('change', [file(), file('empty', []), file('excess', [4])]);
	await rejection;
	assert.equal(f.blobs.size, 3); // Only the earlier successful request remains owned.
	for (const ref of kept) await f.chooser.releaseFile(ref.id);
	const unlimited = f.chooser.getFilesUri({maxFileSize: 0, maxFiles: 0, maxTotalSize: 0});
	await f.elements[2].emit('change', [file(), file('second')]);
	assert.equal((await unlimited).length, 2);
	assert.equal(f.readers.length, 0);
});

test('single copy methods apply aggregate limits too', async () => {
	const f = browserFixture();
	const rejection = assert.rejects(f.chooser.getFileUri({maxTotalSize: 2}), error => error.startsWith('TOTAL_SIZE_EXCEEDED:'));
	await f.elements[0].emit('change', [file()]);
	await rejection;
	assert.equal(f.blobs.size, 0);
});
