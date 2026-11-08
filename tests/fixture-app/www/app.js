/* Only installed into a disposable verification app; no external services. */
var references = new Set();
var log = document.getElementById('log');
function record(label, value) {
	log.textContent += label + ': ' + JSON.stringify(value, function (key, item) {
		if (key === 'data' && item instanceof Uint8Array) return {byteLength: item.byteLength, firstBytes: Array.from(item.slice(0, 16))};
		if (item instanceof Blob) return {size: item.size, type: item.type};
		if (item instanceof ArrayBuffer) return {byteLength: item.byteLength, firstBytes: Array.from(new Uint8Array(item).slice(0, 16))};
		if (key === 'dataURI') return {characters: item.length};
		if (item instanceof Error) return item.message;
		return item;
	}, 2) + '\n';
}
function pick() {
	var method = document.getElementById('method').value;
	var accept = document.getElementById('accept').value;
	var source = document.getElementById('source').value;
	var options = source === 'photos' ? {source: source} : {accept: accept, preferLocal: document.getElementById('local').checked};
	if (!method.endsWith('Metadata')) {
		options.maxFileSize = Number(document.getElementById('limit').value) || null;
		if (method.startsWith('getFiles')) options.maxTotalSize = Number(document.getElementById('total').value) || null;
	}
	if (method.startsWith('getFiles')) options.maxFiles = Number(document.getElementById('count').value) || null;
	if (method.endsWith('Data')) options.format = document.getElementById('format').value;
	chooser[method](options).then(function (result) {
		(Array.isArray(result) ? result : [result]).forEach(function (file) {
			if (file.id) references.add(file.id);
		});
		record(method, result);
	}, function (error) { record(error.code === 'CANCELLED' ? 'canceled' : 'error', error); });
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
