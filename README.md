# Cordova Plugin Chooser

Choose files on Android, iOS, and the Cordova browser platform. Read a small file into JavaScript, inspect metadata, or obtain a temporary reference for a larger file.

Chooser supports single and multiple selection, Promises and callbacks, and TypeScript. It exposes the global `chooser` after Cordova's `deviceready` event.

## Installation

This documentation covers **2.0.0-rc.1**. Install the release candidate explicitly from your Cordova application:

```sh
cordova plugin add cordova-plugin-chooser@2.0.0-rc.1
```

An unversioned installation follows npm's `latest` tag, which may point to a stable 1.x release. If you are upgrading, start with the [migration guide](docs/MIGRATION.md). Historical changes are in the [changelog](CHANGELOG.md).

| Platform | Installation requirement | Maintained families |
| --- | --- | --- |
| Android | `cordova-android >=14.0.0` | 14.x and 15.x |
| iOS | `cordova-ios >=7.0.0` | 7.x and 8.x |
| Browser | Cordova Browser and the required browser APIs | Cordova Browser 7.x |

See [platform setup](docs/PLATFORMS.md) for OS requirements, Swift configuration, and browser features. The plugin requires no blanket Android storage permissions or additional Swift-support plugin. Installing this npm package alone does not initialize Cordova or provide a standalone web or Node.js picker.

## Choose a method

| What your application needs | One file | Multiple files |
| --- | --- | --- |
| Complete contents in JavaScript | `getFile()` | `getFiles()` |
| Name, type, URI, and reported size | `getFileMetadata()` | `getFilesMetadata()` |
| A temporary reference with optional selection limits | `getFileUri()` | `getFilesUri()` |

Cancellation resolves to `undefined`. Successful multiple-selection calls return an array, including when only one file is selected.

Data methods load complete contents into memory. Prefer a URI method with explicit limits for large files or unknown sizes. Native URI methods make an app-private cache copy; browser methods return Blob URLs. Release managed references with `releaseFile(id)` after their consumers finish. **Every browser result has an ID to release**, including data and metadata results.

## Quick start

Add a selection button and status area, then load Cordova's generated script and your application script:

```html
<button id="choose-file" type="button" disabled>Choose a file</button>
<p id="selection" role="status"></p>
<script src="cordova.js"></script>
<script src="app.js"></script>
```

In `app.js`, display metadata without loading the file's complete contents:

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
      output.textContent = 'Could not select a file. Please try again.';
    } finally {
      if (file && file.id) {
        try {
          await chooser.releaseFile(file.id);
        } catch (error) {
          console.error('Could not release the file reference.');
        }
      }
      button.disabled = false;
    }
  });
});
```

Browser pickers must open directly from a user interaction, before awaiting unrelated work. Disable selection controls while a request is active. MIME filters guide the picker; validate selected contents in the component that consumes them.

## Documentation

- [API reference](docs/API.md): methods, overloads, result types, options, and TypeScript.
- [File handling](docs/FILE-HANDLING.md): large files, consumption, ownership, and cleanup.
- [Platforms](docs/PLATFORMS.md): setup, providers, permissions, and lifecycle behavior.
- [Migration](docs/MIGRATION.md): upgrading from 1.3.2.
- [Troubleshooting](docs/TROUBLESHOOTING.md): symptoms and practical checks.
- [Contributing](CONTRIBUTING.md) and [verification](docs/VERIFICATION.md): development and maintenance.
- [Changelog](CHANGELOG.md): current and historical releases.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for licensing and contributor notices.
