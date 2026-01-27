var exec = require('cordova/exec');

function getFileInternal (options, includeData, successCallback, failureCallback) {
	var chooserOptions = Object.assign({ mimeTypes: '*/*', maxFileSize: 0 }, options);

	var result = new Promise(function (resolve, reject) {
		exec(
			function (result) {
				if (result === 'RESULT_CANCELED') {
					resolve();
					return;
				}
				try {
					var o = JSON.parse(result);

					if (!includeData) {
						delete o.data;
					}
					resolve(o);
				}
				catch (err) {
					reject(err);
				}
			},
			reject,
			'Chooser',
			'getFile',
			[ chooserOptions ]
		);
	});

	if (typeof successCallback === 'function') {
		result.then(successCallback);
	}
	if (typeof failureCallback === 'function') {
		result.catch(failureCallback);
	}

	return result;
}

module.exports = {
	getFile: function (accept, successCallback, failureCallback) {
		return getFileInternal(accept, true, successCallback, failureCallback);
	},
	getFileMetadata: function (accept, successCallback, failureCallback) {
		return getFileInternal(accept, false, successCallback, failureCallback);
	}
};
