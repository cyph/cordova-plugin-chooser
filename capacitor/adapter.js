// Generated from typescript/capacitor/adapter.ts. Run npm run build:runtime.
"use strict";
const createChooser = require("../www/chooser-core");
const createBrowserPicker = require("../src/browser/chooser-web");
const attached = new WeakMap();
function details(error) {
    if (typeof error === 'object' && error !== null && 'data' in error) {
        const data = error.data;
        if (typeof data === 'object' && data !== null && 'code' in data)
            return data;
    }
    return error;
}
function attach(capacitor) {
    const previous = attached.get(capacitor);
    if (previous)
        return previous;
    let browser;
    function web() {
        if (typeof document === 'undefined') {
            throw { code: 'UNSUPPORTED', message: 'The picker requires a browser document.' };
        }
        return browser !== null && browser !== void 0 ? browser : (browser = createBrowserPicker());
    }
    const webMethods = {};
    const actions = ['pick', 'cancelPick', 'readFile', 'cancelRead', 'statFile', 'releaseFile'];
    for (const action of actions) {
        webMethods[action] = ({ args }) => new Promise((resolve, reject) => {
            web()[action](value => resolve({ value }), reject, args);
        });
    }
    const native = capacitor.registerPlugin('Chooser', { web: webMethods });
    const chooser = createChooser((resolve, reject, _service, action, args) => {
        if (capacitor.getPlatform() === 'web') {
            // Dispatch synchronously so even the first click retains user activation.
            web()[action](resolve, reject, args);
            return;
        }
        native[action]({ args }).then(result => resolve(result.value), error => reject(details(error)));
    });
    attached.set(capacitor, chooser);
    return chooser;
}
module.exports = attach;
