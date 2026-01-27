
function getFileInternal (
	accept,
	includeData,
	successCallback,
	failureCallback
) {
	if (typeof accept === 'function') {
		failureCallback = successCallback;
		successCallback = accept;
		accept = undefined;
	}

	var result = new Promise(function (resolve, reject) {
		cordova.exec(
			function (json) {
				if (json === 'RESULT_CANCELED') {
					resolve();
					return;
				}

				try {
					var o = JSON.parse(json);

					if (includeData) {
						var base64Data = o.data.replace(
							/[^A-Za-z0-9\+\/]/g,
							''
						);

						o.data = from_base64(base64Data);
						o.dataURI =
							'data:' + o.mediaType + ';base64,' + base64Data;
					}
					else {
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
			[(typeof accept === 'string' ? accept.toLowerCase().replace(/\s/g, '') : undefined) || '*/*']
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

function getFiles(accept, successCallback, failureCallback) {
        var result = new Promise(function (resolve, reject) {
            cordova.exec(
                function (json) {
                    if (json === 'RESULT_CANCELED') {
                        resolve();
                        return;
                    }

                    try {
                        var o = JSON.parse(json);
                        resolve(o);
                    }
                    catch (err) {
                        reject(err);
                    }
                },
                reject,
                'Chooser',
                'getFiles',
                [(typeof accept === 'string' ? accept.replace(/\s/g, '') : undefined) || '*/*']
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
	},
	getFiles
};
