import { Capacitor, registerPlugin } from '@capacitor/core';
import createChooser = require('../www/chooser-core');
import createBrowserPicker = require('../src/browser/chooser-web');

type BrowserPicker = ReturnType<typeof createBrowserPicker>;
type NativePicker = Record<keyof BrowserPicker, (options: {args: unknown[]}) => Promise<{value?: unknown}>>;

function details(error: unknown): unknown {
	if (typeof error === 'object' && error !== null && 'data' in error) {
		const data = error.data;
		if (typeof data === 'object' && data !== null && 'code' in data) return data;
	}
	return error;
}

const native = registerPlugin<NativePicker>('Chooser');
let browser: BrowserPicker | undefined;

export const Chooser = createChooser((resolve, reject, _service, action, args) => {
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
	native[action]({args}).then(result => resolve(result.value), error => reject(details(error)));
});
