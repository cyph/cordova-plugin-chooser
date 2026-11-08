const test = require('node:test');
const assert = require('node:assert/strict');
const {loadChooser} = require('./helpers');

const key = '12345678-1234-4234-8234-123456789abc';
const otherKey = '12345678-1234-4234-8234-123456789abd';
const tick = () => new Promise(setImmediate);
const failure = id => ({id, error: {code: 'RELEASE_FAILED', message: 'locked ' + id}});
const cleanup = (reason, id = key) => ({code: 'CLEANUP_FAILED', outcome: {status: 'rejected', reason}, failures: [failure(id)]});

function cancellation(error, chooser, reason, ids = []) {
	for (const id of ids) {
		assert.ok(error instanceof chooser.CleanupError);
		assert.equal(error.outcome.status, 'rejected');
		assert.equal(error.failures.length, 1);
		assert.equal(error.failures[0].id, id);
		assert.ok(error.failures[0].error instanceof chooser.ChooserError);
		error = error.outcome.reason;
	}
	assert.ok(error instanceof chooser.CancellationError);
	assert.equal(error.reason, 'signal');
	assert.equal(error.cause, reason);
	return true;
}

test('plain, structured, prefixed and serialized picker cancellations preserve signal.reason identity', async () => {
	for (const reason of [{identity: true}, new Error('stop'), 'stop', null, undefined]) {
		for (const response of ['RESULT_CANCELED', {code: 'CANCELLED', reason: 'picker'}, 'CANCELLED: dismissed', JSON.stringify({code: 'CANCELLED', reason: 'signal'})]) {
			let finish;
			const chooser = loadChooser((ok, fail, service, action) => {
				if (action === 'pick') finish = response === 'RESULT_CANCELED' ? ok : fail;
				else ok();
			});
			const controller = new AbortController();
			const pending = chooser.getFileMetadata({signal: controller.signal});
			controller.abort(reason);
			finish(response);
			await assert.rejects(pending, error => cancellation(error, chooser, controller.signal.reason));
		}
	}
});

test('cancellation after a plain picker callback but before its asynchronous settlement keeps the abort cause', async () => {
	let finish;
	const chooser = loadChooser((ok, fail, service, action) => {
		if (action === 'pick') finish = ok;
		else ok();
	});
	const controller = new AbortController();
	const reason = {race: 'plain callback'};
	const pending = chooser.getFileMetadata({signal: controller.signal});
	finish('RESULT_CANCELED');
	controller.abort(reason);
	await assert.rejects(pending, error => cancellation(error, chooser, reason));
});

test('nested native cleanup cancellation outcomes keep every failure and the exact abort reason', async () => {
	for (const leaf of [{code: 'CANCELLED', reason: 'picker'}, 'CANCELLED: stopped', JSON.stringify({code: 'CANCELLED', reason: 'signal'})]) {
		for (const serialized of [false, true]) {
			let finish;
			const chooser = loadChooser((ok, fail, service, action) => {
				if (action === 'pick') finish = fail;
				else ok();
			});
			const controller = new AbortController();
			const reason = {nested: leaf};
			const pending = chooser.getFileMetadata({signal: controller.signal});
			controller.abort(reason);
			const inner = cleanup(leaf, otherKey);
			const response = cleanup(serialized ? JSON.stringify(inner) : inner);
			finish(serialized ? JSON.stringify(response) : response);
			await assert.rejects(pending, error => cancellation(error, chooser, reason, [key, otherKey]));
		}
	}
});

test('typed cleanup outcomes preserve identity of failures and genuine read/decode exceptions during abort', async () => {
	for (const code of ['CANCELLED', 'READ_FAILED', 'DECODE_FAILED']) {
		let finish;
		const chooser = loadChooser((ok, fail, service, action) => {
			if (action === 'pick') finish = fail;
			else ok();
		});
		const controller = new AbortController();
		const reason = {identity: 'typed'};
		const original = code === 'CANCELLED' ? new chooser.CancellationError('picker') : new chooser.ChooserError(code, 'failure frozen before cleanup');
		const failures = [{id: key, error: new chooser.ChooserError('RELEASE_FAILED', 'locked')}];
		const inner = new chooser.CleanupError({status: 'rejected', reason: original}, failures);
		const outer = new chooser.CleanupError({status: 'rejected', reason: inner}, failures);
		const pending = chooser.getFileMetadata({signal: controller.signal});
		controller.abort(reason);
		finish(outer);
		await assert.rejects(pending, error => {
			assert.equal(error.failures, failures);
			assert.equal(error.outcome.reason.failures, failures);
			if (code === 'CANCELLED') return cancellation(error, chooser, reason, [key, key]);
			assert.equal(error, outer);
			assert.equal(error.outcome.reason.outcome.reason, original);
			return true;
		});
	}
});

test('aborted source reads normalize nested native cancellation and retain later JavaScript cleanup failures', async () => {
	for (const format of ['blob', 'arrayBuffer']) {
		for (const releaseFails of [false, true]) {
			let failRead;
			const released = [];
			const chooser = loadChooser((ok, fail, service, action, args) => {
				if (action === 'pick') ok({id: key, kind: 'source', name: 'file', mediaType: 'image/png', size: null});
				else if (action === 'readFile') failRead = fail;
				else if (action === 'releaseFile') {
					released.push(args[0]);
					if (releaseFails) fail({code: 'RELEASE_FAILED', message: 'locked'});
					else ok();
				}
				else ok();
			});
			const controller = new AbortController();
			const reason = {format, releaseFails};
			const pending = chooser.getFileData({format, maxFileSize: null, signal: controller.signal});
			const rejected = assert.rejects(pending, error => cancellation(error, chooser, reason, releaseFails ? [key, key, otherKey] : [key, otherKey]));
			await tick();
			controller.abort(reason);
			failRead(cleanup(cleanup('CANCELLED: source stopped', otherKey)));
			await rejected;
			assert.deepEqual(released, [key]);
		}
	}
});

test('late abort during nested failed read cleanup keeps the original failure outcome', async () => {
	for (const code of ['READ_FAILED', 'DECODE_FAILED']) {
		let finishRelease;
		const chooser = loadChooser((ok, fail, service, action) => {
			if (action === 'pick') ok({id: key, kind: 'source', name: 'file', mediaType: 'text/plain', size: null});
			else if (action === 'readFile') fail(cleanup(cleanup({code, message: 'original'}, otherKey)));
			else if (action === 'releaseFile') finishRelease = fail;
			else ok();
		});
		const controller = new AbortController();
		const pending = chooser.getFileData({format: 'text', maxFileSize: null, signal: controller.signal});
		const rejected = assert.rejects(pending, error => {
			for (const id of [key, key, otherKey]) {
				assert.ok(error instanceof chooser.CleanupError);
				assert.equal(error.outcome.status, 'rejected');
				assert.equal(error.failures[0].id, id);
				error = error.outcome.reason;
			}
			assert.equal(error.code, code);
			assert.equal(error.message, 'original');
			return true;
		});
		await tick();
		controller.abort({late: true});
		finishRelease({code: 'RELEASE_FAILED', message: 'locked'});
		await rejected;
	}
});
