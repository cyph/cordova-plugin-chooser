import type { CapacitorGlobal } from '@capacitor/core';
import attach = require('./adapter');

// A mixed-module host may already have initialized the ESM Capacitor registry.
const existing = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
const { Capacitor } = existing && typeof existing.registerPlugin === 'function'
	? { Capacitor: existing }
	: require('@capacitor/core') as typeof import('@capacitor/core');

export const Chooser = attach(Capacitor);
