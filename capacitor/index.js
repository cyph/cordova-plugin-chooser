const { Capacitor, registerPlugin } = require('@capacitor/core');
const createChooser = require('../www/chooser-core');
const createBrowserPicker = require('../src/browser/chooser-web');

const native = registerPlugin('Chooser');
const chooser = createChooser((resolve, reject, service, action, args) => {
	if (Capacitor.getPlatform() === 'web') {
		if (typeof document === 'undefined') {
			reject({code: 'UNSUPPORTED', message: 'The picker requires a browser document.'});
			return;
		}
		// Dispatch synchronously so even the first click retains user activation.
		browser ??= createBrowserPicker();
		browser[action](resolve, reject, args);
		return;
	}
	native[action]({args}).then(result => resolve(result.value), error => {
		reject(error?.data?.code ? error.data : error);
	});
});
let browser;
exports.Chooser = chooser;
