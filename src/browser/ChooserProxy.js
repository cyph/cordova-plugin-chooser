function errorMessage(code, detail) { return code + ': ' + detail; }

var active = null;
var owned = Object.create(null);
var idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function newId() {
	for (var attempt = 0; attempt < 10; attempt++) {
		var bytes = new Uint8Array(16);
		window.crypto.getRandomValues(bytes);
		bytes[6] = (bytes[6] & 15) | 64;
		bytes[8] = (bytes[8] & 63) | 128;
		var hex = Array.prototype.map.call(bytes, function (byte) {
			return ('0' + byte.toString(16)).slice(-2);
		}).join('');
		var id = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
		if (!Object.prototype.hasOwnProperty.call(owned, id)) {
			return id;
		}
	}
	throw new Error(errorMessage('CACHE_FAILED', 'Could not allocate a managed file id.'));
}

function revoke(id) {
	if (Object.prototype.hasOwnProperty.call(owned, id)) {
		URL.revokeObjectURL(owned[id]);
		delete owned[id];
	}
}

function select(success, failure, options) {
	if (active) {
		failure(errorMessage('BUSY', 'A file picker is already active.'));
		return;
	}
	if (!options || typeof options.accept !== 'string' ||
		['data', 'metadata', 'copy'].indexOf(options.mode) < 0 ||
		typeof options.multiple !== 'boolean' ||
		!Number.isSafeInteger(options.maxFileSize) || options.maxFileSize < 0) {
		failure(errorMessage('INVALID_ARGUMENT', 'Invalid picker options.'));
		return;
	}

	var input = document.createElement('input');
	var reader;
	var finished = false;
	var selected = false;
	var created = [];
	input.type = 'file';
	input.accept = options.accept === '*/*' ? '' : options.accept;
	input.multiple = options.multiple;
	input.style.display = 'none';

	function finish(error, result) {
		if (finished) {
			return;
		}
		finished = true;
		active = null;
		input.removeEventListener('change', onChange);
		input.removeEventListener('cancel', onCancel);
		input.remove();
		if (error || result === 'RESULT_CANCELED') {
			created.forEach(revoke);
		}
		if (error) {
			failure(error);
		}
		else {
			success(result);
		}
	}

	function onCancel() {
		if (!selected) {
			finish(null, 'RESULT_CANCELED');
		}
	}

	function readData(file) {
		return new Promise(function (resolve, reject) {
			reader = new FileReader();
			reader.onerror = function () { reject(new Error(errorMessage('READ_FAILED', 'Could not read the selected file.'))); };
			reader.onabort = function () { reject(new Error(errorMessage('READ_INTERRUPTED', 'File reading was aborted.'))); };
			reader.onload = function () {
				var value = reader.result;
				if (typeof value !== 'string' || value.indexOf(',') < 0) {
					reject(new Error(errorMessage('READ_FAILED', 'Invalid FileReader result.')));
					return;
				}
				resolve(value.slice(value.indexOf(',') + 1));
			};
			reader.readAsDataURL(file);
		});
	}

	async function onChange() {
		if (finished || selected) {
			return;
		}
		selected = true;
		try {
			var files = Array.prototype.slice.call(input.files || []);
			if (!options.multiple) {
				files = files.slice(0, 1);
			}
			if (files.length === 0) {
				finish(null, 'RESULT_CANCELED');
				return;
			}
			var results = [];
			for (var i = 0; i < files.length; i++) {
				if (finished) {
					return;
				}
				var file = files[i];
				if (options.mode === 'copy' && options.maxFileSize > 0 && file.size > options.maxFileSize) {
					throw new Error(errorMessage('FILE_TOO_LARGE', 'Selected file exceeds the byte limit.'));
				}
				var id = newId();
				var uri = URL.createObjectURL(file);
				owned[id] = uri;
				created.push(id);
				var type = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
				var result = {id: id, name: file.name, mediaType: type, uri: uri, size: file.size};
				if (options.mode === 'data') {
					result.data = await readData(file);
					if (finished) {
						return;
					}
				}
				results.push(result);
			}
			finish(null, JSON.stringify(options.multiple ? results : results[0]));
		}
		catch (error) {
			finish(error.message || errorMessage('READ_FAILED', 'File operation failed.'));
		}
	}

	active = function () {
		finish(null, 'RESULT_CANCELED');
		if (reader && reader.readyState === 1) {
			reader.abort();
		}
	};
	input.addEventListener('cancel', onCancel);
	input.addEventListener('change', onChange);
	try {
		document.body.appendChild(input);
		// Must stay in the original user gesture; do not defer this behind a Promise.
		input.click();
	}
	catch (error) {
		finish(errorMessage('PICKER_FAILED', '') + error.message);
	}
}

module.exports = {
	getFile: function (success, failure, args) {
		if (!Array.isArray(args) || typeof args[0] !== 'string' || typeof args[1] !== 'boolean') {
			failure(errorMessage('INVALID_ARGUMENT', 'Expected a MIME filter and includeData boolean.'));
			return;
		}
		select(success, failure, {accept: args[0], mode: args[1] ? 'data' : 'metadata', multiple: false, maxFileSize: 0});
	},
	pick: function (success, failure, args) {
		select(success, failure, args && args[0]);
	},
	releaseFile: function (success, failure, args) {
		var id = args && args[0];
		if (typeof id !== 'string' || id.length !== 36 || !idPattern.test(id)) {
			failure(errorMessage('INVALID_ARGUMENT', 'Expected a managed file id.'));
			return;
		}
		revoke(id);
		success();
	}
};

window.addEventListener('pagehide', function () {
	if (active) {
		active();
	}
	Object.keys(owned).forEach(revoke);
});

require('cordova/exec/proxy').add('Chooser', module.exports);
