import createBrowserPicker = require('./chooser-web');

const proxy: {add(service: 'Chooser', actions: ReturnType<typeof createBrowserPicker>): void} =
	require('cordova/exec/proxy');
proxy.add('Chooser', createBrowserPicker());
