function arrayBufferToBase64(buffer) {
	var binary = '';
	var bytes = new Uint8Array(buffer);
	var len = bytes.byteLength;
	for (var i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return window.btoa(binary);
}

function getFileInternalBrowser(accept, includeData, successCallback, failureCallback) {
	var input = document.createElement('input');
	input.type = 'file';
	if (accept) {
		input.accept = accept;
	}

	input.addEventListener('change', function (event) {
		var file = event.target.files[0];
		if (!file) {
			if (failureCallback) {
				failureCallback('No file selected');
			}
			return;
		}

		// Create a blob URL
		var blobURL = URL.createObjectURL(file);

		// If data inclusion (like base64) is not required, return only the file metadata
		if (!includeData) {
			var result = {
				mediaType: file.type,
				name: file.name,
				uri: blobURL // Blob URL of the file
			};
			successCallback(JSON.stringify(result)); // Send as JSON
			return;
		}

		// If includeData is true, process the file as Blob
		var reader = new FileReader();

		reader.onload = function (e) {
			// Prepare the result object here
			var arrayBuffer = e.target.result; // This is the ArrayBuffer

			// Convert ArrayBuffer to Base64
			var base64Data = arrayBufferToBase64(arrayBuffer);

			var result = {
				data: base64Data, // Store Base64 data
				mediaType: file.type,
				name: file.name,
				uri: blobURL // Use Blob URL
			};

			if (successCallback) {
				successCallback(JSON.stringify(result)); // Send as JSON
			}
		};

		// Now read the file as an arrayBuffer to handle the blob
		reader.readAsArrayBuffer(file); // Read the file as an arrayBuffer
	});

	// Trigger the input click
	document.body.appendChild(input);
	input.click();
	document.body.removeChild(input);
}

module.exports = {
	getFile: function (successCallback, failureCallback, accept) {
		return getFileInternalBrowser(accept, true, successCallback, failureCallback);
	},
	getFileMetadata: function (successCallback, failureCallback, accept) {
		return getFileInternalBrowser(accept, false, successCallback, failureCallback);
	}
};

require('cordova/exec/proxy').add('Chooser', module.exports);