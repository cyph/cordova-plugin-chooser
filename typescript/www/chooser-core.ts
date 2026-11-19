import type chooser = require('../../index');

type Mode = 'copy' | 'metadata' | 'data';
type Source = 'documents' | 'photos';
type Media = 'image' | 'video';
type WireAction = 'pick' | 'cancelPick' | 'readFile' | 'cancelRead' | 'statFile' | 'releaseFile';
type Callback = (value?: unknown) => void;
type Exec = (resolve: Callback, reject: Callback, service: 'Chooser', action: WireAction, args: unknown[]) => void;
type Dictionary = Record<string, unknown>;
type Decoding = {encoding: string, fatal: boolean};
type ReadOptions = {maxBytes: number, signal?: AbortSignal, decoding?: Decoding, format?: chooser.DataFormat};
type RangeOptions = {offset: number, length?: number, signal?: AbortSignal};
type WireOptions = {requestId: string, source: Source, mediaTypes?: Media[], accept: string, mode: Mode, multiple: boolean, localOnly: boolean, maxFileSize: number, maxTotalSize: number, maxFiles: number};
type Selection = {wire: WireOptions, signal?: AbortSignal, decoding?: Decoding, format?: chooser.DataFormat};
type StreamState = {queued: Set<(error: unknown) => void>, isStopped: () => boolean, stop: (error?: unknown) => void};
type Resource = {id: string, kind: 'managed' | 'source', ref?: chooser.FileReference, state: 'active' | 'releasing' | 'released', reads: Set<Promise<void>>, streams: Set<StreamState>, releasePromise?: Promise<void>};
type Chunk = {bytes: Uint8Array<ArrayBuffer>, eof: boolean};
type ReadJob = {work: () => Promise<Chunk>, resolve: (chunk: Chunk) => void, reject: Callback, started: boolean, detach: () => void};
type Budget = {total: number, maxTotal: number, fileCode: chooser.ErrorCode};
type Meta = {name: string, mediaType: string, size: number | null, sourceUri?: string};
type Data = Meta & {size: number, format: chooser.DataFormat, data?: Uint8Array<ArrayBuffer>, dataURI?: string, arrayBuffer?: ArrayBuffer, blob?: Blob, text?: string};
type Selected = chooser.FileMetadata | chooser.ManagedFile | {entry: Resource, info: Meta};

function createChooser(exec: Exec): typeof chooser {
	var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	var managedId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	var chunkSize = 262144;
	var resources = new Map<string, Resource>();
	var releaseQueue: (() => void)[] = [];
	var activeReleases = 0;
	var readQueue: ReadJob[] = [];
	var activeReads = 0;
	var activePicker: string | undefined;
	var random = new Uint32Array(4);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(random);
	else for (var i = 0; i < random.length; i++) random[i] = Math.random() * 0x100000000;
	var requestPrefix = Array.from(random, value => value.toString(16).padStart(8, '0')).join('');
	var requestSequence = 0;
	var formats: readonly chooser.DataFormat[] = ['bytes', 'text', 'dataURI', 'bytesAndDataURI', 'blob', 'arrayBuffer'];
	var errorCodes: readonly chooser.ErrorCode[] = ['INVALID_ARGUMENT', 'BUSY', 'CANCELLED', 'UNSUPPORTED', 'PICKER_FAILED',
		'PERMISSION_DENIED', 'FILE_TOO_LARGE', 'TOO_MANY_FILES', 'TOTAL_SIZE_EXCEEDED', 'READ_FAILED',
		'DECODE_FAILED', 'COPY_FAILED', 'CACHE_FAILED', 'FILE_UNAVAILABLE', 'FILE_RELEASED',
		'RELEASE_FAILED', 'CLEANUP_FAILED', 'OUT_OF_MEMORY'];

	class ChooserError extends Error {
		declare readonly code: chooser.ErrorCode;
		declare readonly failures?: readonly chooser.ReleaseFailure[];
		constructor(code: chooser.ErrorCode, message: string, options?: chooser.ErrorOptions) {
			super(message);
			this.name = 'ChooserError';
			this.code = code;
			if (options && Object.prototype.hasOwnProperty.call(options, 'cause')) this.cause = options.cause;
			if (options && options.failures) this.failures = options.failures;
		}
	}

	class CancellationError extends ChooserError {
		declare readonly code: 'CANCELLED';
		declare readonly name: 'CancellationError';
		declare readonly reason: 'signal' | 'picker';
		constructor(reason: unknown, options?: chooser.ErrorOptions) {
			super('CANCELLED', reason === 'signal' ? 'The operation was aborted.' : 'Selection was cancelled.', options);
			this.name = 'CancellationError';
			this.reason = reason === 'signal' ? 'signal' : 'picker';
		}
	}

	class CleanupError<T = unknown> extends ChooserError {
		declare readonly code: 'CLEANUP_FAILED';
		declare readonly name: 'CleanupError';
		declare readonly failures: readonly chooser.ReleaseFailure[];
		declare readonly outcome: chooser.OperationOutcome<T>;
		constructor(outcome: chooser.OperationOutcome<T>, failures: readonly chooser.ReleaseFailure[]) {
			super('CLEANUP_FAILED', 'The operation completed but some resources could not be released.', {failures: failures});
			this.name = 'CleanupError';
			this.outcome = outcome;
		}
	}

	function invalid(message: string) { return new ChooserError('INVALID_ARGUMENT', message); }
	function own(value: unknown, key: PropertyKey) { return Object.prototype.hasOwnProperty.call(value, key); }
	function record(value: unknown): value is Dictionary { return value !== null && typeof value === 'object' && !Array.isArray(value); }
	function objectOptions(value: unknown, allowed: string[]) {
		if (!record(value) || Object.prototype.toString.call(value) !== '[object Object]') throw invalid('Expected an options object.');
		Object.keys(value).forEach(function (key) {
			if (allowed.indexOf(key) < 0) throw invalid('Unknown option: ' + key + '.');
		});
		return value;
	}
	function noExtraArguments(args: ArrayLike<unknown>, maximum: number) {
		if (args.length > maximum) throw invalid('Callback overloads and extra arguments are not supported.');
	}
	function promiseCall<T>(args: ArrayLike<unknown>, maximum: number, work: () => T | PromiseLike<T>): Promise<T> {
		return new Promise<T>(function (resolve, reject) {
			try { noExtraArguments(args, maximum); resolve(work()); }
			catch (error) { reject(error); }
		});
	}
	function positiveLimit(value: unknown, name: string, optional?: boolean) {
		if (value === null || (optional && value === undefined)) return 0;
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalid(name + ' must be a positive safe integer or null.');
		return value;
	}
	function nonnegative(value: unknown, name: string) {
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(name + ' must be a nonnegative safe integer.');
		return value;
	}
	function checkedSum(a: number, b: number) {
		if (a > Number.MAX_SAFE_INTEGER - b) throw invalid('The requested byte range exceeds safe integer precision.');
		return a + b;
	}
	function validateId(id: unknown) {
		if (typeof id !== 'string' || id.length !== 36 || !managedId.test(id)) throw invalid('Expected a managed file identifier.');
		return id;
	}
	function signalOption(signal: unknown): AbortSignal | undefined {
		if (signal !== undefined && (!record(signal) || typeof signal.aborted !== 'boolean' ||
			typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
			throw invalid('signal must be an AbortSignal.');
		}
		return signal as AbortSignal | undefined;
	}
	function checkSignal(signal?: AbortSignal) {
		if (signal && signal.aborted) throw new CancellationError('signal', {cause: signal.reason});
	}
	function parseResponse(response: unknown): unknown { return typeof response === 'string' ? JSON.parse(response) : response; }
	function nativeError(value: unknown, fallback: chooser.ErrorCode): ChooserError {
		if (value instanceof ChooserError) return value;
		if (typeof value === 'string') {
			var message = value;
			try { value = JSON.parse(message); }
			catch (_) {
				var match = /^([A-Z_]+):\s*(.*)$/.exec(message);
				value = match ? {code: match[1], message: match[2]} : {message: message};
			}
		}
		var code = record(value) && errorCodes.includes(value.code as chooser.ErrorCode) ? value.code as chooser.ErrorCode : fallback;
		if (code === 'CANCELLED') return new CancellationError(record(value) ? value.reason : undefined, {cause: value});
		var options: chooser.ErrorOptions = {cause: value};
		if (record(value) && Array.isArray(value.failures)) {
			options.failures = value.failures.filter(function (failure) {
				return record(failure) && typeof failure.id === 'string' && managedId.test(failure.id);
			}).map(function (failure) { return {id: failure.id, error: nativeError(failure.error, 'RELEASE_FAILED')}; });
		}
		if (code === 'CLEANUP_FAILED') {
			var rawOutcome = record(value) && record(value.outcome) ? value.outcome : {status: 'rejected', reason: record(value) ? value.cause : undefined};
			var outcome: chooser.OperationOutcome;
			if (rawOutcome.status === 'fulfilled') outcome = {status: 'fulfilled', value: rawOutcome.value};
			else {
				var reason = rawOutcome.reason;
				if (typeof reason === 'string') {
					try { var parsed = JSON.parse(reason); if (record(parsed) && typeof parsed.code === 'string') reason = parsed; }
					catch (_) { /* Unstructured consumer exceptions remain unchanged. */ }
				}
				if ((record(reason) && typeof reason.code === 'string') || (typeof reason === 'string' && /^[A-Z_]+:/.test(reason))) {
					reason = nativeError(reason, 'PICKER_FAILED');
				}
				outcome = {status: 'rejected', reason: reason};
			}
			return new CleanupError(outcome, options.failures || []);
		}
		return new ChooserError(code, record(value) && typeof value.message === 'string' ? value.message : 'Chooser operation failed.', options);
	}
	function signalFailure(error: unknown, signal?: AbortSignal): unknown {
		if (!signal || !signal.aborted) return error;
		if (error instanceof CancellationError) return new CancellationError('signal', {cause: signal.reason});
		if (error instanceof CleanupError) {
			var outcome = error.outcome;
			var reason = outcome.status === 'fulfilled' ? new CancellationError('signal', {cause: signal.reason}) : signalFailure(outcome.reason, signal);
			if (outcome.status === 'fulfilled' || reason !== outcome.reason) {
				return new CleanupError({status: 'rejected', reason: reason}, error.failures);
			}
		}
		return error;
	}
	function bridge(action: WireAction, args: unknown[], fallback: chooser.ErrorCode) {
		return new Promise(function (resolve, reject) {
			try { exec(resolve, function (error) { reject(nativeError(error, fallback)); }, 'Chooser', action, args); }
			catch (error) { reject(nativeError(error, fallback)); }
		});
	}

	/* Decode padding as syntax, never as additional zero bytes. */
	function decodeBase64(input: string) {
		if (typeof input !== 'string') throw new ChooserError('READ_FAILED', 'Missing base64 read result.');
		input = input.replace(/\s/g, '');
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) throw new ChooserError('READ_FAILED', 'Invalid base64 read result.');
		var raw = input.replace(/=+$/, '');
		var remainder = raw.length % 4;
		var padding = remainder === 2 ? '==' : remainder === 3 ? '=' : '';
		if (remainder === 1 || (input !== raw && input !== raw + padding)) throw new ChooserError('READ_FAILED', 'Invalid base64 padding.');
		var bytes = new Uint8Array(Math.floor(raw.length * 3 / 4));
		var buffer = 0, bits = 0, index = 0;
		for (var i = 0; i < raw.length; i++) {
			buffer = (buffer << 6) | alphabet.indexOf(raw[i]);
			bits += 6;
			if (bits >= 8) { bits -= 8; bytes[index++] = (buffer >> bits) & 255; }
			buffer &= (1 << bits) - 1;
		}
		if (buffer !== 0) throw new ChooserError('READ_FAILED', 'Invalid base64 trailing bits.');
		return bytes;
	}
	function encodeBase64(bytes: Uint8Array) {
		var parts = [];
		for (var i = 0; i < bytes.length; i += 3) {
			var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
			parts.push(alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)] +
				(b === undefined ? '=' : alphabet[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)]) +
				(c === undefined ? '=' : alphabet[c & 63]));
		}
		return parts.join('');
	}
	function combineBytes(parts: Uint8Array[], length: number) {
		var result = new Uint8Array(length), offset = 0;
		parts.forEach(function (part) { result.set(part, offset); offset += part.length; });
		return result;
	}

	function metadata(value: unknown): Meta {
		if (!record(value) || typeof value.name !== 'string' || typeof value.mediaType !== 'string' ||
			(value.size !== null && (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0)) ||
			(value.sourceUri !== undefined && typeof value.sourceUri !== 'string')) {
			throw new ChooserError('PICKER_FAILED', 'Invalid file metadata.');
		}
		var info: Meta = {name: value.name || 'file', mediaType: value.mediaType || 'application/octet-stream', size: value.size};
		if (value.sourceUri !== undefined) info.sourceUri = value.sourceUri;
		return info;
	}
	function reference(value: unknown): chooser.FileReference {
		var info = metadata(value);
		if (!record(value)) throw invalid('Expected a file reference.');
		var id = validateId(value.id);
		if (typeof value.uri !== 'string' || !/^(?:file|blob):/.test(value.uri) || info.size === null) {
			throw new ChooserError('FILE_UNAVAILABLE', 'Invalid managed file reference.');
		}
		return Object.freeze({...info, id, uri: value.uri, size: info.size});
	}
	function resource(id: string, kind: Resource['kind'], ref?: chooser.FileReference) {
		var entry = resources.get(id);
		if (!entry) {
			entry = {id: id, kind: kind, ref: ref, state: 'active', reads: new Set(), streams: new Set()};
			resources.set(id, entry);
		}
		else if (entry.state !== 'active') throw new ChooserError('FILE_RELEASED', 'The file has been released or is being released.');
		else if (entry.kind !== kind) throw new ChooserError('FILE_UNAVAILABLE', 'Resource identity changed.');
		return entry;
	}
	function usable(entry: Resource) {
		if (entry.state !== 'active') throw new ChooserError('FILE_RELEASED', 'The file has been released or is being released.');
	}
	function lease<T>(entry: Resource, work: () => T | PromiseLike<T>) {
		usable(entry);
		var resolveLease!: () => void;
		var pending = new Promise<void>(function (resolve) { resolveLease = resolve; });
		entry.reads.add(pending);
		return Promise.resolve().then(work).finally(function () { entry.reads.delete(pending); resolveLease(); });
	}
	function scheduleRead(work: () => Promise<Chunk>, signal?: AbortSignal, streamState?: StreamState): Promise<Chunk> {
		return new Promise(function (resolve, reject) {
			var job = {work: work, resolve: resolve, reject: reject, started: false, detach: detach};
			function detach() {
				if (signal) signal.removeEventListener('abort', aborted);
				if (streamState) streamState.queued.delete(cancel);
			}
			function cancel(error: unknown) {
				if (job.started) return;
				var index = readQueue.indexOf(job);
				if (index >= 0) readQueue.splice(index, 1);
				detach();
				reject(error);
			}
			function aborted() { cancel(new CancellationError('signal', {cause: signal?.reason})); }
			if (signal) signal.addEventListener('abort', aborted, {once: true});
			if (streamState) streamState.queued.add(cancel);
			readQueue.push(job);
			if (signal && signal.aborted) aborted();
			else if (streamState && streamState.isStopped()) cancel(new ChooserError('FILE_RELEASED', 'The stream was stopped.'));
			else drainReads();
		});
	}
	function drainReads() {
		while (activeReads < 4 && readQueue.length) {
			(function (job) {
				job.started = true;
				job.detach();
				activeReads++;
				Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(function () { activeReads--; drainReads(); });
			})(readQueue.shift()!);
		}
	}
	function readChunk(entry: Resource, offset: number, length: number, signal?: AbortSignal, streamState?: StreamState) {
		return scheduleRead(async function () {
			checkSignal(signal);
			if (streamState && streamState.isStopped()) throw new ChooserError('FILE_RELEASED', 'The stream was stopped.');
			var value;
			try { value = parseResponse(await bridge('readFile', [entry.id, offset, Math.min(length, Number.MAX_SAFE_INTEGER - offset)], 'READ_FAILED')); }
			catch (error) {
				if (error instanceof CleanupError) throw signalFailure(error, signal);
				if (error instanceof ChooserError) throw error;
				throw new ChooserError('READ_FAILED', 'Invalid read response.', {cause: error});
			}
			checkSignal(signal);
			if (!record(value) || typeof value.eof !== 'boolean' || typeof value.data !== 'string' || value.data.length > Math.ceil(length / 3) * 4 + 1024) {
				throw new ChooserError('READ_FAILED', 'Invalid read response.');
			}
			var bytes = decodeBase64(value.data);
			if (bytes.length > length || (length > 0 && bytes.length === 0 && !value.eof)) {
				throw new ChooserError('READ_FAILED', 'The provider returned an invalid byte count.');
			}
			if (entry.kind === 'managed') {
				var available = Math.max(0, entry.ref!.size - offset);
				if (bytes.length > available || value.eof !== (bytes.length === available)) {
					throw new ChooserError('READ_FAILED', 'The managed file content does not match its recorded size.');
				}
			}
			return {bytes: bytes, eof: value.eof};
		}, signal, streamState);
	}
	function rangeOptions(value: unknown, stream: boolean) {
		var options = objectOptions(value === undefined ? {} : value, ['offset', 'length', 'signal']);
		var offset = options.offset === undefined ? 0 : nonnegative(options.offset, 'offset');
		var length = options.length === undefined && stream ? undefined : nonnegative(options.length, 'length');
		if (length !== undefined) checkedSum(offset, length);
		return {offset: offset, length: length, signal: signalOption(options.signal)};
	}
	function decodingOptions(value: unknown) {
		var options = objectOptions(value === undefined ? {} : value, ['encoding', 'fatal']);
		if (options.encoding !== undefined && (typeof options.encoding !== 'string' || !options.encoding.trim())) throw invalid('encoding must be a nonempty string.');
		if (options.fatal !== undefined && typeof options.fatal !== 'boolean') throw invalid('fatal must be a boolean.');
		return {encoding: options.encoding || 'utf-8', fatal: options.fatal !== false};
	}
	function textDecoder(options?: Decoding) {
		if (typeof TextDecoder !== 'function') throw new ChooserError('UNSUPPORTED', 'TextDecoder is unavailable.');
		try { return new TextDecoder(options?.encoding, {fatal: options?.fatal}); }
		catch (error) { throw invalid('Unsupported text encoding: ' + options?.encoding + '.'); }
	}
	function decoded(decoder: TextDecoder, bytes: Uint8Array<ArrayBuffer> | undefined, final: boolean) {
		try { return decoder.decode(bytes, {stream: !final}); }
		catch (error) { throw new ChooserError('DECODE_FAILED', 'The file is not valid in the selected encoding.', {cause: error}); }
	}
	function dataOptions(options: Dictionary) {
		if (formats.indexOf(options.format as chooser.DataFormat) < 0) throw invalid('An explicit data format is required.');
		if (options.format !== 'text' && (own(options, 'encoding') || own(options, 'fatal'))) throw invalid('encoding and fatal are available only for text.');
		return options.format === 'text' ? decodingOptions({encoding: options.encoding, fatal: options.fatal}) : undefined;
	}
	function wholeOptions(value: unknown, kind?: 'data' | 'text') {
		var allowed = ['maxBytes', 'signal'];
		if (kind === 'text') allowed.push('encoding', 'fatal');
		if (kind === 'data') allowed.push('format', 'encoding', 'fatal');
		var options = objectOptions(value, allowed);
		var result: ReadOptions = {maxBytes: positiveLimit(options.maxBytes, 'maxBytes'), signal: signalOption(options.signal)};
		if (kind === 'text') result.decoding = decodingOptions({encoding: options.encoding, fatal: options.fatal});
		if (kind === 'data') { result.format = options.format as chooser.DataFormat; result.decoding = dataOptions(options); }
		return result;
	}
	async function materialize(entry: Resource, info: chooser.FileMetadata, options: ReadOptions, format: chooser.DataFormat, budget?: Budget): Promise<Data> {
		return lease(entry, async function () {
			checkSignal(options.signal);
			var decoder = format === 'text' ? textDecoder(options.decoding) : undefined;
			var chunks = [], text = [], encoded = [], carry = new Uint8Array(0), offset = 0;
			while (true) {
				var length = chunkSize;
				if (options.maxBytes) length = Math.min(length, options.maxBytes - offset + 1);
				if (budget && budget.maxTotal) length = Math.min(length, budget.maxTotal - budget.total + 1);
				var part = await readChunk(entry, offset, length, options.signal);
				offset = checkedSum(offset, part.bytes.length);
				if (options.maxBytes && offset > options.maxBytes) throw new ChooserError(budget && budget.fileCode || 'FILE_TOO_LARGE', 'The file exceeds the byte limit.');
				if (budget) {
					budget.total = checkedSum(budget.total, part.bytes.length);
					if (budget.maxTotal && budget.total > budget.maxTotal) throw new ChooserError('TOTAL_SIZE_EXCEEDED', 'The selection exceeds the aggregate byte limit.');
				}
				if (format === 'bytes' || format === 'bytesAndDataURI' || format === 'arrayBuffer' || format === 'blob') chunks.push(part.bytes);
				if (decoder) text.push(decoded(decoder, part.bytes, false));
				if (format === 'dataURI' || format === 'bytesAndDataURI') {
					var bytes = carry.length ? combineBytes([carry, part.bytes], carry.length + part.bytes.length) : part.bytes;
					var complete = bytes.length - bytes.length % 3;
					encoded.push(encodeBase64(bytes.subarray(0, complete)));
					carry = bytes.slice(complete);
				}
				if (part.eof) break;
			}
			checkSignal(options.signal);
			if (decoder) text.push(decoded(decoder, undefined, true));
			if (format === 'dataURI' || format === 'bytesAndDataURI') encoded.push(encodeBase64(carry));
			var result: Data = Object.assign({}, info, {size: offset, format: format});
			if (format === 'blob') {
				if (typeof Blob !== 'function') throw new ChooserError('UNSUPPORTED', 'Blob is unavailable.');
				result.blob = new Blob(chunks, {type: info.mediaType});
			}
			if (format === 'bytes' || format === 'bytesAndDataURI') result.data = combineBytes(chunks, offset);
			if (format === 'arrayBuffer') result.arrayBuffer = combineBytes(chunks, offset).buffer;
			if (format === 'text') result.text = text.join('');
			if (format === 'dataURI' || format === 'bytesAndDataURI') result.dataURI = 'data:' + info.mediaType + ';base64,' + encoded.join('');
			return result;
		});
	}
	async function rangeRead(entry: Resource, options: RangeOptions) {
		return lease(entry, async function () {
			checkSignal(options.signal);
			var chunks = [], length = 0;
			var requested = options.length!;
			while (length < requested) {
				var part = await readChunk(entry, checkedSum(options.offset, length), Math.min(chunkSize, requested - length), options.signal);
				chunks.push(part.bytes); length += part.bytes.length;
				if (part.eof) break;
			}
			return combineBytes(chunks, length);
		});
	}
	function fileStream(entry: Resource, value: unknown, text: boolean) {
		usable(entry);
		var options: RangeOptions, decoding: Decoding | undefined;
		if (text) {
			var input = objectOptions(value === undefined ? {} : value, ['offset', 'length', 'signal', 'encoding', 'fatal']);
			decoding = decodingOptions({encoding: input.encoding, fatal: input.fatal});
			options = rangeOptions({offset: input.offset, length: input.length, signal: input.signal}, true);
		}
		else options = rangeOptions(value, true);
		if (typeof ReadableStream !== 'function') throw new ChooserError('UNSUPPORTED', 'ReadableStream is unavailable.');
		checkSignal(options.signal);
		var decoder = text ? textDecoder(decoding) : undefined;
		var controller: ReadableStreamDefaultController<string | Uint8Array<ArrayBuffer>>, stopped = false, offset = options.offset, remaining = options.length, pendingPull: Promise<Chunk> | undefined;
		var streamState: StreamState = {queued: new Set(), isStopped: function () { return stopped; }, stop: function (error?: unknown) {
			if (stopped) return;
			stopped = true;
			streamState.queued.forEach(function (cancel) { cancel(error || new ChooserError('FILE_RELEASED', 'The stream was stopped.')); });
			entry.streams.delete(streamState);
			if (options.signal) options.signal.removeEventListener('abort', aborted);
			if (error) controller.error(error);
		}};
		function aborted() { streamState.stop(new CancellationError('signal', {cause: options.signal?.reason})); }
		function close() {
			if (decoder) { var tail = decoded(decoder, undefined, true); if (tail) controller.enqueue(tail); }
			streamState.stop(); controller.close();
		}
		return new ReadableStream<string | Uint8Array<ArrayBuffer>>({
			start: function (value) {
				controller = value;
				entry.streams.add(streamState);
				if (options.signal) { options.signal.addEventListener('abort', aborted, {once: true}); if (options.signal.aborted) aborted(); }
			},
			pull: async function () {
				if (stopped) return;
				try {
					while (!stopped) {
						if (remaining === 0) { close(); return; }
						pendingPull = lease(entry, function () {
							return readChunk(entry, offset, remaining === undefined ? chunkSize : Math.min(chunkSize, remaining), options.signal, streamState);
						});
						var part = await pendingPull;
						if (stopped) return;
						offset = checkedSum(offset, part.bytes.length);
						if (remaining !== undefined) remaining -= part.bytes.length;
						var output = decoder ? decoded(decoder, part.bytes, false) : part.bytes;
						if (output.length) controller.enqueue(output);
						if (part.eof || remaining === 0) { close(); return; }
						if (output.length) return;
					}
				}
				catch (error) { streamState.stop(error); }
			},
			cancel: function () {
				streamState.stop();
				return pendingPull ? pendingPull.then(function () {}, function () {}) : undefined;
			}
		}, {highWaterMark: 0});
	}
	function managedFile(ref: chooser.FileReference): chooser.ManagedFile {
		var entry = resource(ref.id, 'managed', ref);
		var handle = Object.assign({}, ref, {
			bytes: function (options: unknown) { return promiseCall(arguments, 1, function () { return materialize(entry, metadata(ref), wholeOptions(options), 'bytes'); }).then(function (value) { return value.data!; }); },
			arrayBuffer: function (options: unknown) { return promiseCall(arguments, 1, function () { return materialize(entry, metadata(ref), wholeOptions(options), 'arrayBuffer'); }).then(function (value) { return value.arrayBuffer!; }); },
			blob: function (options: unknown) { return promiseCall(arguments, 1, function () { return materialize(entry, metadata(ref), wholeOptions(options), 'blob'); }).then(function (value) { return value.blob!; }); },
			text: function (options: unknown) { return promiseCall(arguments, 1, function () { return materialize(entry, metadata(ref), wholeOptions(options, 'text'), 'text'); }).then(function (value) { return value.text!; }); },
			dataURI: function (options: unknown) { return promiseCall(arguments, 1, function () { return materialize(entry, metadata(ref), wholeOptions(options), 'dataURI'); }).then(function (value) { return value.dataURI!; }); },
			getData: function <F extends chooser.DataFormat>(options: chooser.ManagedDataOptions<F>) { return promiseCall(arguments, 1, function () { var parsed = wholeOptions(options, 'data'); return materialize(entry, metadata(ref), parsed, parsed.format!) as unknown as Promise<chooser.FileData<F>>; }); },
			readRange: function (options: unknown) { return promiseCall(arguments, 1, function () { return rangeRead(entry, rangeOptions(options, false)); }); },
			stream: function (options?: chooser.StreamOptions) { noExtraArguments(arguments, 1); return fileStream(entry, options, false) as ReadableStream<Uint8Array<ArrayBuffer>>; },
			textStream: function (options?: chooser.TextStreamOptions) { noExtraArguments(arguments, 1); return fileStream(entry, options, true) as ReadableStream<string>; },
			release: function () { return promiseCall(arguments, 0, function () { return releaseOne(ref.id, entry); }); },
			toJSON: function () { return Object.assign({}, ref); }
		});
		return Object.freeze(handle);
	}
	function drainReleases() {
		while (activeReleases < 4 && releaseQueue.length) releaseQueue.shift()!();
	}
	function releaseOne(id: string, entry = resources.get(id) ?? resource(id, 'managed')) {
		if (entry.state === 'released') return Promise.resolve();
		if (entry.releasePromise) return entry.releasePromise;
		entry.state = 'releasing';
		entry.streams.forEach(function (stream) { stream.stop(new ChooserError('FILE_RELEASED', 'The file was released.')); });
		entry.releasePromise = Promise.all(Array.from(entry.reads)).then(function () {
			return new Promise<void>((resolve, reject) => {
				releaseQueue.push(() => {
					activeReleases++;
					bridge('releaseFile', [id], 'RELEASE_FAILED').then(() => resolve(), reject).finally(() => {
						activeReleases--;
						drainReleases();
					});
				});
				drainReleases();
			});
		}).then(function () {
			entry.state = 'released';
			entry.ref = undefined;
			resources.delete(id);
		}).finally(function () { entry.releasePromise = undefined; });
		return entry.releasePromise;
	}
	function releaseFile(id: unknown) {
		return promiseCall(arguments, 1, function () { return releaseOne(validateId(id)); });
	}
	function releaseFiles(ids: unknown) {
		return promiseCall(arguments, 1, async function () {
			if (!Array.isArray(ids)) throw invalid('Expected an array of managed file identifiers.');
			/* Read each index once, including holes, before validation or mutation. */
			var snapshot: unknown[] = [], length = ids.length;
			for (var i = 0; i < length; i++) snapshot.push(own(ids, i) ? ids[i] : undefined);
			var valid = snapshot.map(validateId);
			var failures: chooser.ReleaseFailure[] = [];
			await Promise.all(Array.from(new Set(valid)).map(async function (id) {
				try { await releaseOne(id); }
				catch (error) { failures.push({id: id, error: nativeError(error, 'RELEASE_FAILED')}); }
			}));
			if (failures.length) throw new ChooserError('RELEASE_FAILED', 'Some files could not be released.', {failures: failures});
		});
	}
	async function cleanupOutcome<T>(ids: string[], outcome: chooser.OperationOutcome<T>) {
		try { await releaseFiles(ids); }
		catch (error) { throw new CleanupError(outcome, error instanceof ChooserError ? error.failures || [] : []); }
		if (outcome.status === 'rejected') throw outcome.reason;
		return outcome.value;
	}
	function resultIds(value: unknown): string[] {
		return (Array.isArray(value) ? value : [value]).filter(function (file) {
			return record(file) && typeof file.id === 'string' && file.id.length === 36 && managedId.test(file.id);
		}).map(function (file) { return file.id; });
	}
	function normalizeAccept(value: unknown) {
		if (value === undefined) return '*/*';
		var filters = Array.isArray(value) ? value : [value];
		if (!filters.length) throw invalid('accept must contain at least one MIME type.');
		var normalized: string[] = [];
		for (var i = 0; i < filters.length; i++) {
			var filter = own(filters, i) ? filters[i] : undefined;
			if (typeof filter !== 'string') throw invalid('accept must be a MIME string or array of MIME strings.');
			filter.split(',').forEach(function (part) {
				part = part.trim().toLowerCase();
				if (!/^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+))$/.test(part)) throw invalid('Invalid MIME filter.');
				if (normalized.indexOf(part) < 0) normalized.push(part);
			});
		}
		return normalized.join(',');
	}
	function pickerOptions(value: unknown, mode: Mode, multiple: boolean): Selection {
		var options = objectOptions(value === undefined && mode === 'metadata' ? {} : value,
			['source', 'accept', 'preferLocal', 'mediaTypes', 'signal'].concat(multiple ? ['maxFiles'] : [])
				.concat(mode !== 'metadata' ? ['maxFileSize'].concat(multiple ? ['maxTotalSize'] : []) : [])
				.concat(mode === 'data' ? ['format', 'encoding', 'fatal'] : []));
		var source = options.source === undefined ? 'documents' : options.source;
		if (source !== 'documents' && source !== 'photos') throw invalid('Unknown picker source.');
		var wire: WireOptions = {requestId: 'chooser-' + requestPrefix + '-' + (++requestSequence), source: source, accept: '*/*', mode: mode, multiple: multiple,
			localOnly: false, maxFileSize: 0, maxTotalSize: 0, maxFiles: 0};
		if (source === 'photos') {
			if (own(options, 'accept') || own(options, 'preferLocal')) throw invalid('Photo selection accepts mediaTypes instead of document options.');
			var mediaTypes = options.mediaTypes === undefined ? ['image', 'video'] : options.mediaTypes;
			if (!Array.isArray(mediaTypes) || !mediaTypes.length || Array.from(mediaTypes).some(function (type) { return type !== 'image' && type !== 'video'; })) throw invalid('mediaTypes must select images, videos, or both.');
			wire.mediaTypes = Array.from(new Set(mediaTypes as Media[]));
		}
		else {
			if (own(options, 'mediaTypes')) throw invalid('mediaTypes is available only for photos.');
			wire.accept = normalizeAccept(options.accept);
			if (options.preferLocal !== undefined && typeof options.preferLocal !== 'boolean') throw invalid('preferLocal must be a boolean.');
			wire.localOnly = options.preferLocal === true;
		}
		if (mode !== 'metadata') {
			wire.maxFileSize = positiveLimit(options.maxFileSize, 'maxFileSize');
			if (multiple) wire.maxTotalSize = positiveLimit(options.maxTotalSize, 'maxTotalSize');
		}
		if (multiple) wire.maxFiles = positiveLimit(options.maxFiles, 'maxFiles', true);
		var decoding = mode === 'data' ? dataOptions(options) : undefined;
		if (decoding) textDecoder(decoding);
		return {wire: wire, signal: signalOption(options.signal), decoding: decoding, format: options.format as chooser.DataFormat | undefined};
	}
	function callPicker(value: unknown, mode: Mode, multiple: boolean, args: ArrayLike<unknown>) {
		/* The executor intentionally reaches exec synchronously in the original gesture. */
		return new Promise(function (resolve, reject) {
			var options: Selection;
			try {
				noExtraArguments(args, 1);
				options = pickerOptions(value, mode, multiple);
				checkSignal(options.signal);
				if (activePicker) throw new ChooserError('BUSY', 'A picker is already active.');
			}
			catch (error) { reject(error); return; }
			var request = options.wire.requestId, terminal = false, aborted = false, sourceIds: string[] = [];
			activePicker = request;
			function abort() {
				aborted = true;
				bridge('cancelPick', [request], 'PICKER_FAILED').catch(function () { /* Original picker owns terminal settlement. */ });
				sourceIds.forEach(function (id) {
					bridge('cancelRead', [id], 'READ_FAILED').catch(function () { /* Release still waits for the original read and reports cleanup failures. */ });
				});
			}
			function detach() { if (options.signal) options.signal.removeEventListener('abort', abort); }
			function endPicker() { if (activePicker === request) activePicker = undefined; }
			function finishRejected(error: unknown) {
				endPicker(); detach(); reject(signalFailure(error, options.signal));
			}
			function failed(error?: unknown) {
				if (terminal) return;
				terminal = true;
				var failure = nativeError(error, 'PICKER_FAILED');
				finishRejected(failure);
			}
			function succeeded(response: unknown) {
				if (terminal) return;
				terminal = true;
				var raw: unknown;
				Promise.resolve().then(async function () {
					if (response === 'RESULT_CANCELED') { checkSignal(options.signal); throw new CancellationError('picker'); }
					try { raw = parseResponse(response); }
					catch (error) { throw new ChooserError('PICKER_FAILED', 'Invalid picker response.', {cause: error}); }
					var ids = resultIds(raw);
					try {
						if (aborted) throw new CancellationError('signal', {cause: options.signal?.reason});
						checkSignal(options.signal);
						var selected = multiple ? raw : [raw];
						if (!Array.isArray(selected) || !selected.length || (!multiple && Array.isArray(raw))) throw new ChooserError('PICKER_FAILED', 'Expected a nonempty selection.');
						if (options.wire.maxFiles && selected.length > options.wire.maxFiles) throw new ChooserError('TOO_MANY_FILES', 'Too many files were selected.');
						if (new Set(ids).size !== ids.length) throw new ChooserError('PICKER_FAILED', 'Duplicate managed resource identities.');
						var total = 0;
						var files = selected.map(function (file: unknown): Selected {
							var info = metadata(file);
							if (mode === 'metadata') {
								if (own(file, 'id') || own(file, 'uri') || own(file, 'data') || own(file, 'dataURI')) throw new ChooserError('PICKER_FAILED', 'Metadata selection unexpectedly retained resources or data.');
								return info;
							}
							if (mode === 'data') {
								if (!record(file)) throw invalid('Invalid source reader.');
								var id = validateId(file.id);
								if (file.kind !== 'source') throw new ChooserError('PICKER_FAILED', 'Expected a transient source reader.');
								return {entry: resource(id, 'source'), info: info};
							}
							var ref = reference(file);
							total = checkedSum(total, ref.size);
							if (options.wire.maxFileSize && ref.size > options.wire.maxFileSize) throw new ChooserError('FILE_TOO_LARGE', 'The file exceeds the byte limit.');
							if (options.wire.maxTotalSize && total > options.wire.maxTotalSize) throw new ChooserError('TOTAL_SIZE_EXCEEDED', 'The selection exceeds the aggregate byte limit.');
							return managedFile(ref);
						});
						if (mode === 'data') {
							sourceIds = ids;
							var output: Data[] = [], budget: Budget = {total: 0, maxTotal: options.wire.maxTotalSize, fileCode: 'FILE_TOO_LARGE'};
							for (var i = 0; i < files.length; i++) {
								var file = files[i];
								if (!('entry' in file)) throw invalid('Invalid source reader.');
								output.push(await materialize(file.entry, file.info, {maxBytes: options.wire.maxFileSize, signal: options.signal, decoding: options.decoding}, options.format!, budget));
							}
							return cleanupOutcome(ids, {status: 'fulfilled', value: multiple ? output : output[0]});
						}
						checkSignal(options.signal);
						return multiple ? files : files[0];
					}
					catch (error) {
						return cleanupOutcome(ids, {status: 'rejected', reason: error});
					}
				}).then(function (result) {
					if (options.signal && options.signal.aborted) {
						/* Cancellation can win while direct-data cleanup is awaiting native release. */
						cleanupOutcome(mode === 'data' ? [] : resultIds(raw), {status: 'rejected', reason: new CancellationError('signal', {cause: options.signal?.reason})})
							.catch(finishRejected);
						return;
					}
					endPicker(); detach(); resolve(result);
				}, finishRejected);
			}
			if (options.signal) options.signal.addEventListener('abort', abort, {once: true});
			try { exec(succeeded, failed, 'Chooser', 'pick', [options.wire]); }
			catch (error) { failed(error); }
		});
	}
	async function restoreFile(value: unknown, options?: chooser.OperationOptions) {
		noExtraArguments(arguments, 2);
		var saved: chooser.FileReference;
		try { saved = reference(value); }
		catch (error) { throw invalid('Expected a complete saved managed file reference.'); }
		var parsed = objectOptions(options === undefined ? {} : options, ['signal']);
		var signal = signalOption(parsed.signal);
		checkSignal(signal);
		var entry = resource(saved.id, 'managed', saved);
		var stat = await lease(entry, async function () {
			var result;
			try { result = parseResponse(await bridge('statFile', [saved.id], 'FILE_UNAVAILABLE')); }
			catch (error) { if (error instanceof ChooserError) throw error; throw new ChooserError('FILE_UNAVAILABLE', 'Invalid file status.', {cause: error}); }
			checkSignal(signal);
			if (!record(result) || result.id !== saved.id || typeof result.uri !== 'string' ||
				typeof result.size !== 'number' || !Number.isSafeInteger(result.size) || result.size < 0) {
				throw new ChooserError('FILE_UNAVAILABLE', 'Invalid authoritative file status.');
			}
			return reference(Object.assign({}, saved, result));
		});
		entry.ref = stat;
		return managedFile(stat);
	}
	function withSelection<T extends chooser.ManagedFile | chooser.NonEmptyArray<chooser.ManagedFile>, U>(options: unknown, consume: (files: T) => U, multiple: boolean, args: ArrayLike<unknown>) {
		/* Do not await before picker dispatch: browser selection needs this gesture. */
		var selection;
		try {
			noExtraArguments(args, 2);
			if (typeof consume !== 'function') throw invalid('A scoped file consumer is required.');
			selection = callPicker(options, 'copy', multiple, [options]) as Promise<T>;
		}
		catch (error) { return Promise.reject(error); }
		return selection.then(async function (value) {
			var files = (multiple ? value : [value]) as readonly chooser.ManagedFile[];
			var ids = files.map(function (file) { return file.id; });
			var outcome: chooser.OperationOutcome<Awaited<U>>;
			try { outcome = {status: 'fulfilled', value: await consume(value)}; }
			catch (error) { outcome = {status: 'rejected', reason: error}; }
			return cleanupOutcome(ids, outcome);
		});
	}

	return {
		ChooserError: ChooserError, CancellationError: CancellationError, CleanupError: CleanupError,
		getFile: function(options: chooser.GetFileOptions) { return callPicker(options, 'copy', false, arguments) as Promise<chooser.ManagedFile>; },
		getFiles: function(options: chooser.GetFilesOptions) { return callPicker(options, 'copy', true, arguments) as Promise<chooser.NonEmptyArray<chooser.ManagedFile>>; },
		getFileMetadata: function(options?: chooser.GetFileMetadataOptions) { return callPicker(options, 'metadata', false, arguments) as Promise<chooser.FileMetadata>; },
		getFilesMetadata: function(options?: chooser.GetFilesMetadataOptions) { return callPicker(options, 'metadata', true, arguments) as Promise<chooser.NonEmptyArray<chooser.FileMetadata>>; },
		getFileData: function <F extends chooser.DataFormat>(options: chooser.GetFileDataOptions<F>) { return callPicker(options, 'data', false, arguments) as Promise<chooser.FileData<F>>; },
		getFilesData: function <F extends chooser.DataFormat>(options: chooser.GetFilesDataOptions<F>) { return callPicker(options, 'data', true, arguments) as Promise<chooser.NonEmptyArray<chooser.FileData<F>>>; },
		withFile: function <T>(options: chooser.GetFileOptions, consume: (file: chooser.ManagedFile) => T | PromiseLike<T>) { return withSelection(options, consume, false, arguments); },
		withFiles: function <T>(options: chooser.GetFilesOptions, consume: (files: chooser.NonEmptyArray<chooser.ManagedFile>) => T | PromiseLike<T>) { return withSelection(options, consume, true, arguments); },
		restoreFile: restoreFile, releaseFile: releaseFile, releaseFiles: releaseFiles
	};
}

export = createChooser;
