module.exports = {
    getFiles: function (accept, successCallback, failureCallback) {
        var result = new Promise(function (resolve, reject) {
            cordova.exec(
                function (json) {
                    try {
                        resolve(JSON.parse(json));
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
};