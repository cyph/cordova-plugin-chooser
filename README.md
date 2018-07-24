Cordova FileChooser Plugin

Requires Cordova >= 2.8.0

Install with Cordova CLI
	
	$ cordova plugin add http://github.com/don/cordova-filechooser.git

Install with Plugman 

	$ plugman --platform android --project /path/to/project \ 
		--plugin http://github.com/don/cordova-filechooser.git

API

	fileChooser.open(successCallback, failureCallback);

The success callback get the data URI of the selected file

	fileChooser.open(function(dataURI) {
		alert(dataURI);
	});
	
Screenshot

![Screenshot](filechooser.png "Screenshot")

Supported Platforms:
- Android

TODO rename `open` to pick, select, or choose.
