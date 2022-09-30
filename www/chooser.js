var exec = require('cordova/exec');

function getFileInternal (options, successCallback, failureCallback) {
	var chooserOptions = Object.assign({ mimeTypes: '*/*', maxFileSize: 0 }, options);

	var result = new Promise(function (resolve, reject) {
		exec(
			function (result) {
				if (result === 'RESULT_CANCELED') {
					resolve();
					return;
				}
				resolve(result);
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
	getFile: function (options, successCallback, failureCallback) {
		return getFileInternal(options, successCallback, failureCallback);
	},
};
