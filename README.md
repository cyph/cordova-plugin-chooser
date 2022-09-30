# Chooser

## Overview

File chooser plugin for Cordova.

Install with Cordova CLI:

	$ cordova plugin add cordova-plugin-chooser

Supported Platforms:

* Android

* iOS

## API

	/**
	 * Displays native prompt for user to select a file.
	 *
	 * @param {Object} options
	 * @param {string} options.mimeTypes Optional MIME type filter (e.g. 'image/gif,video/*')
	 * @param {number} options.maxFileSize 
	 *
	 * @returns Promise containing selected file's 
	 * path, display name, MIME type, , and original URI.
	 *
	 * If user cancels, promise will be resolved as undefined.
	 * If error occurs, promise will be rejected.
	 */
	chooser.getFile(options?: {}) : Promise<undefined|{
		path: string;
		name: string;
		mimeType: string;
		extension: string;
		size: number;
	}>

## Example Usage

	(async () => {
		const file = await chooser.getFile();
		console.log(file ? file.name : 'canceled');
	})();


## Platform-Specific Notes

The following must be added to config.xml to prevent crashing when selecting large files
on Android:

```
<platform name="android">
	<edit-config
		file="app/src/main/AndroidManifest.xml"
		mode="merge"
		target="/manifest/application"
	>
		<application android:largeHeap="true" />
	</edit-config>
</platform>
```

If it isn't present already, you'll also need the attribute `xmlns:android="http://schemas.android.com/apk/res/android"` added to your `<widget>` tag in order for that to build successfully.
