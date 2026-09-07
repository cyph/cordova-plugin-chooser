var exec = require('cordova/exec');
var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var managedId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* Keep padding in data URIs without decoding padding as additional zero bytes. */
function decodeFile(file, includeData) {
	if (!file || typeof file !== 'object' || Array.isArray(file)) {
		throw new TypeError('Invalid file result.');
	}
	if (!includeData) {
		delete file.data;
		delete file.dataURI;
		return file;
	}
	if (typeof file.data !== 'string') {
		throw new TypeError('Missing base64 file data.');
	}
	var input = file.data.replace(/\s/g, '');
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
		throw new TypeError('Invalid base64 file data.');
	}
	var raw = input.replace(/=+$/, '');
	var remainder = raw.length % 4;
	if (remainder === 1 || (input.length !== raw.length && input.length % 4 !== 0)) {
		throw new TypeError('Invalid base64 file length.');
	}
	var padding = remainder === 2 ? '==' : remainder === 3 ? '=' : '';
	if (input.length !== raw.length && input !== raw + padding) {
		throw new TypeError('Invalid base64 padding.');
	}
	var bytes = new Uint8Array(Math.floor(raw.length * 3 / 4));
	var buffer = 0;
	var bits = 0;
	var index = 0;
	for (var i = 0; i < raw.length; i++) {
		buffer = (buffer << 6) | alphabet.indexOf(raw[i]);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[index++] = (buffer >> bits) & 255;
		}
		buffer &= (1 << bits) - 1;
	}
	if (buffer !== 0) {
		throw new TypeError('Invalid base64 trailing bits.');
	}
	file.data = bytes;
	file.dataURI = 'data:' + file.mediaType + ';base64,' + raw + padding;
	return file;
}

function normalizeAccept(accept) {
	return (typeof accept === 'string' ? accept.toLowerCase().replace(/\s/g, '') : '') || '*/*';
}

/* A callback's exception must not change the returned Promise's file result. */
function notify(callback, value) {
	if (typeof callback === 'function') {
		function report(error) { setTimeout(function () { throw error; }, 0); }
		try {
			var returned = callback(value);
			if (returned && typeof returned.then === 'function') {
				Promise.resolve(returned).catch(report);
			}
		}
		catch (error) {
			report(error);
		}
	}
}

function withCallbacks(promise, success, failure) {
	if (typeof success === 'function' || typeof failure === 'function') {
		promise.then(
			function (value) { notify(success, value); },
			function (error) { notify(failure, error); }
		);
	}
	return promise;
}

function callPicker(accept, success, failure, configuration) {
	var mode = configuration.mode;
	var multiple = configuration.multiple;
	var copy = mode === 'copy';
	if (typeof accept === 'function') {
		failure = success;
		success = accept;
		accept = undefined;
	}
	var result = new Promise(function (resolve, reject) {
		var options = {
			accept: normalizeAccept(accept),
			mode: mode,
			multiple: multiple,
			maxFileSize: 0,
			localOnly: false
		};
		if (copy) {
			if (accept !== undefined && accept !== null && typeof accept !== 'string') {
				if (typeof accept !== 'object' || Array.isArray(accept)) {
					throw new TypeError('Expected a MIME filter or copy options.');
				}
				if (accept.accept !== undefined && typeof accept.accept !== 'string') {
					throw new TypeError('accept must be a string.');
				}
				options.accept = normalizeAccept(accept.accept);
				if (accept.maxFileSize !== undefined) {
					if (typeof accept.maxFileSize !== 'number' || !Number.isSafeInteger(accept.maxFileSize) || accept.maxFileSize < 0) {
						throw new TypeError('maxFileSize must be a nonnegative safe integer in bytes.');
					}
					options.maxFileSize = accept.maxFileSize;
				}
				if (accept.localOnly !== undefined) {
					if (typeof accept.localOnly !== 'boolean') {
						throw new TypeError('localOnly must be a boolean.');
					}
					options.localOnly = accept.localOnly;
				}
			}
		}
		var legacy = !multiple && !copy;
		exec(function (response) {
			if (response === 'RESULT_CANCELED') {
				resolve();
				return;
			}
			try {
				var value = typeof response === 'string' ? JSON.parse(response) : response;
				if (multiple) {
					if (!Array.isArray(value) || value.length === 0) {
						throw new TypeError('Expected a nonempty file array.');
					}
					value = value.map(function (file) { return decodeFile(file, mode === 'data'); });
				}
				else {
					value = decodeFile(value, mode === 'data');
				}
				resolve(value);
			}
			catch (error) {
				reject(error);
			}
		}, reject, 'Chooser', legacy ? 'getFile' : 'pick',
		legacy ? [options.accept, mode === 'data'] : [options]);
	});
	return withCallbacks(result, success, failure);
}

module.exports = {
	getFile: function (accept, success, failure) {
		return callPicker(accept, success, failure, {mode: 'data', multiple: false});
	},
	getFileMetadata: function (accept, success, failure) {
		return callPicker(accept, success, failure, {mode: 'metadata', multiple: false});
	},
	getFiles: function (accept, success, failure) {
		return callPicker(accept, success, failure, {mode: 'data', multiple: true});
	},
	getFilesMetadata: function (accept, success, failure) {
		return callPicker(accept, success, failure, {mode: 'metadata', multiple: true});
	},
	getFileUri: function (options, success, failure) {
		return callPicker(options, success, failure, {mode: 'copy', multiple: false});
	},
	getFilesUri: function (options, success, failure) {
		return callPicker(options, success, failure, {mode: 'copy', multiple: true});
	},
	releaseFile: function (id, success, failure) {
		var result = new Promise(function (resolve, reject) {
			if (typeof id !== 'string' || id.length !== 36 || !managedId.test(id)) {
				throw new TypeError('Expected a managed file id returned by chooser.');
			}
			exec(function () { resolve(); }, reject, 'Chooser', 'releaseFile', [id]);
		});
		return withCallbacks(result, success, failure);
	}
};
