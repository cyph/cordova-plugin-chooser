type Callback = (value?: unknown) => void;
type Dispatch = (success: Callback, reject: Callback, args: unknown[]) => void;
type Action = 'pick' | 'cancelPick' | 'cancelRead' | 'statFile' | 'readFile' | 'releaseFile';
type PickerOptions = {
	requestId: string;
	source: 'documents' | 'photos';
	accept: string;
	mode: 'metadata' | 'copy' | 'data';
	multiple: boolean;
	localOnly: boolean;
	mediaTypes?: ('image' | 'video')[];
	maxFileSize: number;
	maxFiles: number;
	maxTotalSize: number;
};
type Metadata = {name: string, mediaType: string, size: number, id?: string, uri?: string, kind?: 'source'};
type OwnedFile = {
	file: File;
	result: Metadata;
	source: boolean;
	offset: number;
	limit: number;
	budget: {bytes: number, limit: number};
	tail: Promise<unknown>;
	closing: boolean;
	release: Promise<void> | null;
	cancelled?: boolean;
};

function dictionary(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function message(error: unknown, fallback: string) {
	return dictionary(error) && typeof error.message === 'string' && error.message ? error.message : fallback;
}

function createBrowserPicker(): Record<Action, Dispatch> {
	var active: {input: HTMLInputElement, requestId: string, cancel: (reason: 'picker' | 'signal') => void} | null = null;
	var owned: Record<string, OwnedFile | undefined> = Object.create(null);
	var idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	var chunkSize = 262144;

	function failure(code: string, message: string) { return {code: code, message: message}; }
	function validateId(id: unknown): asserts id is string {
		if (typeof id !== 'string' || id.length !== 36 || !idPattern.test(id)) {
			throw failure('INVALID_ARGUMENT', 'Expected a managed file identifier.');
		}
	}
	function newId() {
		for (var attempt = 0; attempt < 10; attempt++) {
			var bytes = new Uint8Array(16);
			window.crypto.getRandomValues(bytes);
			bytes[6] = (bytes[6] & 15) | 64;
			bytes[8] = (bytes[8] & 63) | 128;
			var hex = Array.from(bytes, function (byte) { return ('0' + byte.toString(16)).slice(-2); }).join('');
			var id = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
			if (!owned[id]) return id;
		}
		throw failure('CACHE_FAILED', 'Could not allocate a managed file identifier.');
	}
	function metadata(file: File): Metadata {
		if (!Number.isSafeInteger(file.size) || file.size < 0) throw failure('READ_FAILED', 'Invalid file size.');
		return {
			name: typeof file.name === 'string' && file.name ? file.name : 'file',
			mediaType: /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.type) ? file.type : 'application/octet-stream',
			size: file.size
		};
	}
	function close(id: unknown): Promise<void> {
		validateId(id);
		const record = owned[id];
		if (!record) return Promise.resolve();
		if (record.release) return record.release;
		record.closing = true;
		record.release = record.tail.catch(function () {}).then(function () {
			if (record.result.uri) URL.revokeObjectURL(record.result.uri);
			delete owned[id];
		}).catch(function (error) {
			record.release = null;
			throw failure('RELEASE_FAILED', message(error, 'Could not release the browser file.'));
		});
		return record.release;
	}
	function optionsValid(options: unknown): options is PickerOptions {
		return dictionary(options) && typeof options.requestId === 'string' && options.requestId.length > 0 &&
			(options.source === 'documents' || options.source === 'photos') && typeof options.accept === 'string' &&
			(options.mode === 'metadata' || options.mode === 'copy' || options.mode === 'data') && typeof options.multiple === 'boolean' &&
			typeof options.localOnly === 'boolean' && ['maxFileSize', 'maxFiles', 'maxTotalSize'].every(function (key) {
				var value = options[key];
				return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
			}) && (options.source !== 'photos' || (Array.isArray(options.mediaTypes) && options.mediaTypes.length > 0 &&
				options.mediaTypes.every(function (type) { return type === 'image' || type === 'video'; })));
	}
	function select(success: Callback, reject: Callback, value: unknown) {
		if (!optionsValid(value)) { reject(failure('INVALID_ARGUMENT', 'Invalid picker options.')); return; }
		if (active) { reject(failure('BUSY', 'A file picker is already active.')); return; }
		var options = value;
		var input = document.createElement('input');
		var finished = false;
		var selected = false;
		var created: string[] = [];
		input.type = 'file';
		input.accept = options.source === 'photos' ? options.mediaTypes!.map(function (type) { return type + '/*'; }).join(',') :
			options.accept === '*/*' ? '' : options.accept;
		input.multiple = options.multiple;
		input.style.display = 'none';
		function finish(error: unknown, result?: Metadata | Metadata[]) {
			if (finished) return;
			finished = true;
			if (active && active.input === input) active = null;
			input.removeEventListener('change', onChange);
			input.removeEventListener('cancel', onCancel);
			input.remove();
			if (error) {
				Promise.allSettled(created.map(close)).then(function (releases) {
					var failures = releases.flatMap(function (release, index) {
						return release.status === 'rejected' ? [{id: created[index], error: release.reason}] : [];
					});
					if (failures.length) reject({code: 'CLEANUP_FAILED', message: 'Selection cleanup failed.',
						outcome: {status: 'rejected', reason: error}, failures: failures});
					else reject(error);
				});
			}
			else success(result);
		}
		function cancel(reason: 'picker' | 'signal') { finish({code: 'CANCELLED', reason: reason, message: 'File selection was cancelled.'}); }
		function onCancel() { if (!selected) cancel('picker'); }
		function onChange() {
			if (finished || selected) return;
			selected = true;
			try {
				var files = Array.from(input.files || []);
				if (!options.multiple) files = files.slice(0, 1);
				if (!files.length) { cancel('picker'); return; }
				if (options.maxFiles && files.length > options.maxFiles) throw failure('TOO_MANY_FILES', 'Selection exceeds the file count limit.');
				var total = 0;
				var budget = {bytes: 0, limit: options.maxTotalSize};
				var results = files.map(function (file) {
					var result = metadata(file);
					if (options.mode === 'metadata') return result;
					if (options.maxFileSize && file.size > options.maxFileSize) throw failure('FILE_TOO_LARGE', 'File exceeds the byte limit.');
					if (file.size > Number.MAX_SAFE_INTEGER - total || (options.maxTotalSize && file.size > options.maxTotalSize - total)) {
						throw failure('TOTAL_SIZE_EXCEEDED', 'Selection exceeds the total byte limit.');
					}
					total += file.size;
					var id = newId();
					result.id = id;
					if (options.mode === 'copy') result.uri = URL.createObjectURL(file);
					else result.kind = 'source';
					owned[id] = {file: file, result: result, source: options.mode === 'data', offset: 0,
						limit: options.maxFileSize, budget: budget, tail: Promise.resolve(), closing: false, release: null};
					created.push(id);
					return result;
				});
				finish(null, options.multiple ? results : results[0]);
			}
			catch (error) { finish(dictionary(error) && error.code ? error : failure('PICKER_FAILED', message(error, 'File selection failed.'))); }
		}
		active = {input: input, requestId: options.requestId, cancel: cancel};
		input.addEventListener('change', onChange);
		input.addEventListener('cancel', onCancel);
		try {
			document.body.appendChild(input);
			// Keep the input activation in the caller's user gesture.
			input.click();
		}
		catch (error) { finish(failure('PICKER_FAILED', message(error, 'Could not open the picker.'))); }
	}

	var proxy: Record<Action, Dispatch> = {
		pick: function (success, reject, args) { select(success, reject, args && args[0]); },
		cancelPick: function (success, reject, args) {
			if (!args || typeof args[0] !== 'string') { reject(failure('INVALID_ARGUMENT', 'Expected a request identifier.')); return; }
			if (active && active.requestId === args[0]) active.cancel('signal');
			success();
		},
		cancelRead: function (success, reject, args) {
			try {
				var id = args && args[0];
				validateId(id);
				const record = owned[id];
				if (record && !record.source) throw failure('INVALID_ARGUMENT', 'Only transient source reads can be cancelled by identifier.');
				if (record) record.cancelled = true;
				success();
			}
			catch (error) { reject(error); }
		},
		statFile: function (success, reject, args) {
			try {
				var id = args && args[0];
				validateId(id);
				const record = owned[id];
				if (!record || record.source || record.closing) throw failure('FILE_UNAVAILABLE', 'The browser file is no longer available.');
				success(Object.assign({}, record.result));
			}
			catch (error) { reject(error); }
		},
		readFile: function (success, reject, args) {
			try {
				const [id, offset, length] = args ?? [];
				validateId(id);
				if (typeof offset !== 'number' || typeof length !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
					length > chunkSize || length > Number.MAX_SAFE_INTEGER - offset) throw failure('INVALID_ARGUMENT', 'Invalid read range.');
				const record = owned[id];
				if (!record || record.closing) throw failure('FILE_UNAVAILABLE', 'The browser file is no longer available.');
				var job = record.tail.then(async function () {
					if (record.cancelled) throw {code: 'CANCELLED', reason: 'signal', message: 'Source read was cancelled.'};
					if (record.source && offset !== record.offset) throw failure('INVALID_ARGUMENT', 'Source reads must be sequential.');
					var bytes;
					try { bytes = new Uint8Array(await record.file.slice(offset, offset + length).arrayBuffer()); }
					catch (error) { throw failure('READ_FAILED', message(error, 'Could not read the browser file.')); }
					if (record.cancelled) throw {code: 'CANCELLED', reason: 'signal', message: 'Source read was cancelled.'};
					if (bytes.length > length) throw failure('READ_FAILED', 'File returned more bytes than requested.');
					if (record.source) {
						if (record.limit && bytes.length > record.limit - record.offset) throw failure('FILE_TOO_LARGE', 'File exceeds the byte limit.');
						if (bytes.length > Number.MAX_SAFE_INTEGER - record.budget.bytes ||
							(record.budget.limit && bytes.length > record.budget.limit - record.budget.bytes)) {
							throw failure('TOTAL_SIZE_EXCEEDED', 'Selection exceeds the total byte limit.');
						}
						record.offset += bytes.length;
						record.budget.bytes += bytes.length;
					}
					var binary = '';
					for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
					return {data: btoa(binary), eof: offset + bytes.length >= record.file.size || (length > 0 && bytes.length < length)};
				});
				record.tail = job.catch(function () {});
				job.then(success, reject);
			}
			catch (error) { reject(error); }
		},
		releaseFile: function (success, reject, args) {
			try { close(args && args[0]).then(success, reject); }
			catch (error) { reject(error); }
		}
	};
	window.addEventListener('pagehide', function () {
		if (active) active.cancel('signal');
		Object.keys(owned).forEach(function (id) { close(id).catch(function () {}); });
	});
	return proxy;
}

export = createBrowserPicker;
