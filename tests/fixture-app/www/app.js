/* Only installed into a disposable verification app; no external services. */
var references = new Set();
var log = document.getElementById('log');
function record(label, value) {
	log.textContent += label + ': ' + JSON.stringify(value, function (key, item) {
		if (key === 'data' && item instanceof Uint8Array) return {byteLength: item.byteLength, firstBytes: Array.from(item.slice(0, 16))};
		if (key === 'dataURI') return {characters: item.length};
		if (item instanceof Error) return item.message;
		return item;
	}, 2) + '\n';
}
function pick() {
	var method = document.getElementById('method').value;
	var accept = document.getElementById('accept').value;
	var options = method.endsWith('Uri') ? {
		accept: accept, maxFileSize: Number(document.getElementById('limit').value),
		maxFiles: Number(document.getElementById('count').value),
		maxTotalSize: Number(document.getElementById('total').value),
		localOnly: document.getElementById('local').checked
	} : accept;
	chooser[method](options).then(function (result) {
		if (result === undefined) { record('canceled', null); return; }
		(Array.isArray(result) ? result : [result]).forEach(function (file) {
			if (file.id) references.add(file.id);
		});
		record(method, result);
	}, function (error) { record('error', error); });
}
document.addEventListener('deviceready', function () {
	['pick', 'twice', 'release'].forEach(function (id) { document.getElementById(id).disabled = false; });
	document.getElementById('pick').onclick = pick;
	document.getElementById('twice').onclick = function () { pick(); pick(); };
	document.getElementById('release').onclick = function () {
		Array.from(references).forEach(function (id) {
			chooser.releaseFile(id).then(function () {
				references.delete(id);
				record('released', id);
			}, function (error) { record('release error', error); });
		});
	};
	record('ready', cordova.platformId);
});
document.addEventListener('resume', function (event) {
	// Android process restoration delivers through resume, not the lost JS Promise.
	record('resume', event.pendingResult || null);
});
