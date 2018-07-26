/** @see sodiumutil */
function from_base64(sBase64, nBlocksSize) {
    function _b64ToUint6(nChr) {
        return nChr > 64 && nChr < 91 ?
            nChr - 65 : nChr > 96 && nChr < 123 ?
            nChr - 71 : nChr > 47 && nChr < 58 ?
            nChr + 4 : nChr === 43 ?
            62 : nChr === 47 ?
            63 :
            0;
    }

    var sB64Enc = sBase64.replace(/[^A-Za-z0-9\+\/]/g, ""),
        nInLen = sB64Enc.length,
        nOutLen = nBlocksSize ? Math.ceil((nInLen * 3 + 1 >> 2) / nBlocksSize) * nBlocksSize : nInLen * 3 + 1 >> 2,
        taBytes = new Uint8Array(nOutLen);

    for (var nMod3, nMod4, nUint24 = 0, nOutIdx = 0, nInIdx = 0; nInIdx < nInLen; nInIdx++) {
        nMod4 = nInIdx & 3;
        nUint24 |= _b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << 18 - 6 * nMod4;
        if (nMod4 === 3 || nInLen - nInIdx === 1) {
            for (nMod3 = 0; nMod3 < 3 && nOutIdx < nOutLen; nMod3++, nOutIdx++) {
                taBytes[nOutIdx] = nUint24 >>> (16 >>> nMod3 & 24) & 255;
            }
            nUint24 = 0;
        }
    }
    return taBytes;
}

module.exports = {
    select: function (accept) {
        return new Promise(function (resolve, reject) {
            cordova.exec(
                function (json) {
                    try {
                        var o = JSON.parse(json);
                        o.data = from_base64(o.data);
                        resolve(o);
                    }
                    catch (err) {
                        reject(err);
                    }
                },
                reject,
                "FileChooser",
                "select",
                [accept]
            );
        });
    }
};
