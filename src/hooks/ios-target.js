'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = function checkIosTarget(context) {
	const options = context.opts || {};
	const root = options.projectRoot;
	if (!root) throw new Error('Chooser could not locate the Cordova project.');
	const platforms = options.cordova && options.cordova.platforms || options.platforms;
	if (Array.isArray(platforms) ? !platforms.includes('ios') : !fs.existsSync(path.join(root, 'platforms/ios'))) return;
	const {ConfigParser} = context.requireCordovaModule('cordova-common');
	const config = new ConfigParser(path.join(root, 'config.xml'));
	const target = config.getPreference('deployment-target', 'ios');
	if (typeof target !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(target) || Number(target.split('.')[0]) < 15) {
		throw new Error('cordova-plugin-chooser requires iOS 15 or later. Set <preference name="deployment-target" value="15.0" /> in config.xml, or keep your existing higher target.');
	}
};
