import type { CapacitorGlobal } from '@capacitor/core';
import createChooser = require('../www/chooser-core');
import createBrowserPicker = require('../src/browser/chooser-web');

type BrowserPicker = ReturnType<typeof createBrowserPicker>;
type NativePicker = Record<keyof BrowserPicker, (options: {args: unknown[]}) => Promise<{value?: unknown}>>;
const attached = new WeakMap<CapacitorGlobal, ReturnType<typeof createChooser>>();

function details(error: unknown): unknown {
	if (typeof error === 'object' && error !== null && 'data' in error) {
		const data = error.data;
		if (typeof data === 'object' && data !== null && 'code' in data) return data;
	}
	return error;
}

function attach(capacitor: CapacitorGlobal) {
	const previous = attached.get(capacitor);
	if (previous) return previous;
	let browser: BrowserPicker | undefined;
	function web(): BrowserPicker {
		if (typeof document === 'undefined') {
			throw {code: 'UNSUPPORTED', message: 'The picker requires a browser document.'};
		}
		return browser ??= createBrowserPicker();
	}
	const webMethods = {} as NativePicker;
	const actions: (keyof BrowserPicker)[] = ['pick', 'cancelPick', 'readFile', 'cancelRead', 'statFile', 'releaseFile'];
	for (const action of actions) {
		webMethods[action] = ({args}) => new Promise((resolve, reject) => {
			web()[action](value => resolve({value}), reject, args);
		});
	}
	const native = capacitor.registerPlugin<NativePicker>('Chooser', {web: webMethods});

	const chooser = createChooser((resolve, reject, _service, action, args) => {
		if (capacitor.getPlatform() === 'web') {
			// Dispatch synchronously so even the first click retains user activation.
			web()[action](resolve, reject, args);
			return;
		}
		native[action]({args}).then(result => resolve(result.value), error => reject(details(error)));
	});
	attached.set(capacitor, chooser);
	return chooser;
}

export = attach;
