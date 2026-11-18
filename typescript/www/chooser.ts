import createChooser = require('./chooser-core');

const chooser = createChooser(require('cordova/exec'));
export = chooser;
