// Generated from typescript/capacitor/index.ts. Run npm run build:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Chooser = void 0;
const attach = require("./adapter");
// A mixed-module host may already have initialized the ESM Capacitor registry.
const existing = globalThis.Capacitor;
const { Capacitor } = existing && typeof existing.registerPlugin === 'function'
    ? { Capacitor: existing }
    : require('@capacitor/core');
exports.Chooser = attach(Capacitor);
