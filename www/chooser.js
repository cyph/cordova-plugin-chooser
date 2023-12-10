var exec = require('cordova/exec');

/** @see sodiumutil */
function from_base64 (sBase64, nBlocksSize) {
	function _b64ToUint6 (nChr) {
		return nChr > 64 && nChr < 91 ?
			nChr - 65 :
		nChr > 96 && nChr < 123 ?
			nChr - 71 :
		nChr > 47 && nChr < 58 ?
			nChr + 4 :
		nChr === 43 ?
			62 :
		nChr === 47 ?
			63 :
			0;
	}

	var nInLen = sBase64.length;
	var nOutLen = nBlocksSize ?
		Math.ceil(((nInLen * 3 + 1) >> 2) / nBlocksSize) * nBlocksSize :
		(nInLen * 3 + 1) >> 2;
	var taBytes = new Uint8Array(nOutLen);

	for (
		var nMod3, nMod4, nUint24 = 0, nOutIdx = 0, nInIdx = 0;
		nInIdx < nInLen;
		nInIdx++
	) {
		nMod4 = nInIdx & 3;
		nUint24 |= _b64ToUint6(sBase64.charCodeAt(nInIdx)) << (18 - 6 * nMod4);
		if (nMod4 === 3 || nInLen - nInIdx === 1) {
			for (
				nMod3 = 0;
				nMod3 < 3 && nOutIdx < nOutLen;
				nMod3++, nOutIdx++
			) {
				taBytes[nOutIdx] = (nUint24 >>> ((16 >>> nMod3) & 24)) & 255;
			}
			nUint24 = 0;
		}
	}

	return taBytes;
}

function getFileInternal (options, successCallback, failureCallback) {
	var chooserOptions = Object.assign({ mimeTypes: '*/*', maxFileSize: 0 }, options);

	var result = new Promise(function (resolve, reject) {
		exec(
			function (result) {
				if (result === 'RESULT_CANCELED') {
					resolve();
					return;
				}

				try {
					var base64Data = result.data.replace(/[^A-Za-z0-9\+\/]/g, '');

					result.data = from_base64(base64Data);
					result.dataURI = 'data:' + result.mimeType + ';base64,' + base64Data;

					resolve(result);
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
	getFile: function (options, successCallback, failureCallback) {
		return getFileInternal(options, successCallback, failureCallback);
	},
};
