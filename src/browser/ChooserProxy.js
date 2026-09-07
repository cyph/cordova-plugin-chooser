/* Browser implementation originally contributed by @andreszs in upstream PR #52. */
var active = null;
var urls = [];

function getFile(success, failure, args) {
	if (active) {
		failure('BUSY: A file picker is already active.');
		return;
	}

	var input = document.createElement('input');
	var reader;
	var uri;
	var finished = false;
	input.type = 'file';
	input.accept = args[0] === '*/*' ? '' : args[0];
	input.style.display = 'none';

	function finish(error, result) {
		if (finished) {
			return;
		}
		finished = true;
		active = null;
		input.remove();
		if (error && uri) {
			URL.revokeObjectURL(uri);
		}
		if (error) {
			failure(error);
		}
		else {
			if (uri) {
				urls.push(uri);
			}
			success(result);
		}
	}

	active = function () {
		finish(null, 'RESULT_CANCELED');
		if (reader && reader.readyState === 1) {
			reader.abort();
		}
	};
	input.addEventListener('cancel', function () {
		finish(null, 'RESULT_CANCELED');
	});
	input.addEventListener('change', function () {
		if (finished) {
			return;
		}
		var file = input.files && input.files[0];
		if (!file) {
			finish(null, 'RESULT_CANCELED');
			return;
		}
		try {
			uri = URL.createObjectURL(file);
			var result = {
				mediaType: file.type || 'application/octet-stream',
				name: file.name,
				uri: uri
			};
			if (!args[1]) {
				finish(null, JSON.stringify(result));
				return;
			}
			reader = new FileReader();
			reader.onerror = function () {
				finish('READ_FAILED: Could not read the selected file.');
			};
			reader.onabort = function () {
				finish('READ_FAILED: Reading the selected file was aborted.');
			};
			reader.onload = function () {
				try {
					result.data = reader.result.slice(reader.result.indexOf(',') + 1);
					finish(null, JSON.stringify(result));
				}
				catch (error) {
					finish('READ_FAILED: ' + error.message);
				}
			};
			reader.readAsDataURL(file);
		}
		catch (error) {
			finish('READ_FAILED: ' + error.message);
		}
	});

	try {
		document.body.appendChild(input);
		input.click();
	}
	catch (error) {
		finish('PICKER_FAILED: ' + error.message);
	}
}

window.addEventListener('pagehide', function () {
	if (active) {
		active();
	}
	urls.forEach(function (uri) { URL.revokeObjectURL(uri); });
	urls = [];
});

module.exports = {getFile: getFile};
require('cordova/exec/proxy').add('Chooser', module.exports);
