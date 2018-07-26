Cordova FileChooser Plugin

Requires Cordova >= 2.8.0

Install with Cordova CLI
	
	$ cordova plugin add http://github.com/don/cordova-filechooser.git

Install with Plugman 

	$ plugman --platform android --project /path/to/project \ 
		--plugin http://github.com/don/cordova-filechooser.git

API

	fileChooser.select(accept?: string) : Promise<{
		data: Uint8Array;
		mediaType: string;
		name: string;
		uri: string;
	}>

Optionally takes a MIME type filter.

Returns a promise with the binary data, MIME type, name, and URI of the selected file.

	const file = await fileChooser.select();
	
Screenshot

![Screenshot](filechooser.png "Screenshot")

Supported Platforms:
- Android
- iOS
