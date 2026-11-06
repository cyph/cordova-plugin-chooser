# Cordova Plugin Chooser

Let people choose files in a Cordova app on Android, iOS, or the browser platform. Read a small file into JavaScript, inspect its metadata, or give a temporary file reference to another consumer. Single and multiple selection, Promises, callbacks, and TypeScript are supported.

## Installation

From your Cordova application, install version 2.0.0-rc.1:

```sh
cordova plugin add cordova-plugin-chooser@2.0.0-rc.1
```

Review the [known limitations of 2.0.0-rc.1](docs/KNOWN-ISSUES.md), including iOS Files intermittently remaining open after selection in simulator tests. The impact on physical devices has not been established.

The plugin requires `cordova-android >=14.0.0` or `cordova-ios >=7.0.0` on native platforms. Browser use requires Cordova Browser and supported browser APIs. See [platform setup](docs/PLATFORMS.md) for requirements and configuration. Installing the npm package alone does not provide a standalone web or Node.js picker.

Upgrading from an earlier release? See the [migration guide](docs/MIGRATION.md) and [changelog](CHANGELOG.md).

## Choose a method

| Need | One file | Multiple files |
| --- | --- | --- |
| Contents in JavaScript | `getFile()` | `getFiles()` |
| Metadata without a full read by the plugin | `getFileMetadata()` | `getFilesMetadata()` |
| Temporary reference with optional size and count limits | `getFileUri()` | `getFilesUri()` |

Data methods read the whole file into memory and offer no configurable size limits. For larger or unknown inputs, use a URI method with limits and a consumer that can handle the reference. Native URI methods create private cache copies; browser results use managed Blob URLs. Release an ID after all consumers finish. Every browser result has an ID, including metadata and data results; on native platforms only URI results have one.

Cancellation resolves to `undefined`. A successful multiple selection returns a nonempty array. MIME filters guide the picker, but do not validate the selected contents.

## Quick start

Add these elements to your Cordova app's HTML:

```html
<button id="choose-file" type="button" disabled>Choose a file</button>
<p id="selection" role="status"></p>
<script src="cordova.js"></script>
<script src="app.js"></script>
```

In `app.js`, wait for Cordova and select a file when the button is clicked:

```js
document.addEventListener('deviceready', () => {
  const button = document.getElementById('choose-file');
  const output = document.getElementById('selection');
  button.disabled = false;

  button.addEventListener('click', async () => {
    button.disabled = true;
    let file;
    try {
      file = await chooser.getFileMetadata('image/*,application/pdf');
      output.textContent = file
        ? `${file.name}: ${file.size === null ? 'unknown size' : file.size + ' bytes'}`
        : 'Selection canceled.';
    } catch (error) {
      output.textContent = 'Could not select a file.';
    } finally {
      if (file && file.id) {
        try {
          await chooser.releaseFile(file.id);
        } catch (error) {
          console.error('Could not release the file reference.', error);
        }
      }
      button.disabled = false;
    }
  });
});
```

Browsers require the picker call directly from a user interaction and file-input `cancel` event support. Only one request can be active at a time, including processing after selection. See [platform behavior](docs/PLATFORMS.md).

## Documentation

- [API reference](docs/API.md): calls, results, options, errors, and TypeScript.
- [File handling](docs/FILE-HANDLING.md): consumption, cleanup, memory, CSP, and parsing.
- [Platforms](docs/PLATFORMS.md): setup, providers, and lifecycle behavior.
- [Migration](docs/MIGRATION.md) and [troubleshooting](docs/TROUBLESHOOTING.md).
- [Known limitations](docs/KNOWN-ISSUES.md).
- [Contributing](CONTRIBUTING.md), [verification](docs/VERIFICATION.md), and [changelog](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for licensing and contributor notices.
