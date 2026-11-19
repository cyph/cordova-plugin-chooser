// Generated from typescript/src/browser/ChooserProxy.ts. Run npm run build:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const createBrowserPicker = require("./chooser-web");
const proxy = require('cordova/exec/proxy');
proxy.add('Chooser', createBrowserPicker());
