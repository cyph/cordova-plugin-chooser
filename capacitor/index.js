// Generated from typescript/capacitor/index.ts. Run npm run build.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Chooser = void 0;
const core_1 = require("@capacitor/core");
const createChooser = require("../www/chooser-core");
const createBrowserPicker = require("../src/browser/chooser-web");
function details(error) {
    if (typeof error === 'object' && error !== null && 'data' in error) {
        const data = error.data;
        if (typeof data === 'object' && data !== null && 'code' in data)
            return data;
    }
    return error;
}
const native = (0, core_1.registerPlugin)('Chooser');
let browser;
exports.Chooser = createChooser((resolve, reject, _service, action, args) => {
    if (core_1.Capacitor.getPlatform() === 'web') {
        if (typeof document === 'undefined') {
            reject({ code: 'UNSUPPORTED', message: 'The picker requires a browser document.' });
            return;
        }
        // Dispatch synchronously so even the first click retains user activation.
        browser ??= createBrowserPicker();
        browser[action](resolve, reject, args);
        return;
    }
    native[action]({ args }).then(result => resolve(result.value), error => reject(details(error)));
});
