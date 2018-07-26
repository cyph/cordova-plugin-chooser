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
	 * @param accept Optional MIME type filter (e.g. 'image/*').
	 *
	 * @returns Promise containing selected file's binary data,
	 * MIME type, display name, and full URI.
	 */
	chooser.getFile(accept?: string) : Promise<{
		data: Uint8Array;
		mediaType: string;
		name: string;
		uri: string;
	}>

## Example Usage

	(async () => {
		const file = await chooser.getFile();
		console.log(file.name);
	})();
