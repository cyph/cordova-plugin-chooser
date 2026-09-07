const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function loadChooser(exec, timers = []) {
	const context = {
		module: {exports: {}}, Promise, Uint8Array,
		require: name => {
			if (name !== 'cordova/exec') throw new Error('Unexpected dependency: ' + name);
			return exec;
		},
		setTimeout: callback => timers.push(callback)
	};
	vm.runInNewContext(fs.readFileSync(path.join(root, 'www/chooser.js'), 'utf8'), context);
	return context.module.exports;
}

function browserFixture() {
	const elements = [];
	const readers = [];
	const blobs = new Map();
	const revoked = [];
	const windowListeners = new Map();
	let proxy;
	let sequence = 0;
	const document = {
		createElement() {
			const listeners = new Map();
			const element = {
				style: {}, files: [], attached: false, clicked: false,
				addEventListener: (name, callback) => listeners.set(name, callback),
				removeEventListener: name => listeners.delete(name),
				remove() { this.attached = false; },
				click() { this.clicked = true; },
				emit(name, files) {
					if (files) this.files = files;
					return listeners.get(name)?.();
				}
			};
			elements.push(element);
			return element;
		},
		body: {appendChild(element) { element.attached = true; }}
	};
	class Reader {
		constructor() { this.readyState = 0; readers.push(this); }
		readAsDataURL(file) { this.file = file; this.readyState = 1; }
		complete() {
			this.readyState = 2;
			this.result = 'data:' + this.file.type + ';base64,' + Buffer.from(this.file.bytes || []).toString('base64');
			this.onload();
		}
		fail() { this.readyState = 2; this.onerror(); }
		abort() { this.readyState = 2; this.onabort(); }
	}
	const context = {
		module: {exports: {}}, Promise, Uint8Array, document, FileReader: Reader,
		window: {
			crypto: {getRandomValues(bytes) { bytes.fill(0); bytes[15] = ++sequence; return bytes; }},
			addEventListener: (name, callback) => windowListeners.set(name, callback)
		},
		URL: {
			createObjectURL(file) { const uri = 'blob:fixture/' + sequence; blobs.set(uri, file); return uri; },
			revokeObjectURL(uri) { revoked.push(uri); blobs.delete(uri); }
		},
		require: name => {
			if (name !== 'cordova/exec/proxy') throw new Error('Unexpected dependency');
			return {add(service, value) { if (service !== 'Chooser') throw new Error('Wrong service'); proxy = value; }};
		}
	};
	vm.runInNewContext(fs.readFileSync(path.join(root, 'src/browser/ChooserProxy.js'), 'utf8'), context);
	const chooser = loadChooser((ok, fail, service, action, args) => proxy[action](ok, fail, args));
	return {chooser, proxy, elements, readers, blobs, revoked, pagehide: () => windowListeners.get('pagehide')()};
}

module.exports = {loadChooser, browserFixture};
