# Cordova Plugin Chooser

Choose documents, photos, and videos in a Cordova app on Android, iOS, or the browser platform. Work with managed files: inspect metadata, read a range, stream the contents, or pass a temporary URI to another consumer. For small files, request text, bytes, a Blob, an ArrayBuffer, or a data URI directly.

These docs describe **2.0.0-rc.2**. RC2 changes the API; see the [migration guide](docs/MIGRATION.md) before upgrading from RC1 or 1.x.

## Installation

Use Cordova Android 14/15, Cordova iOS 7/8, or Cordova Browser 7. iOS applications must target **iOS 15 or later**. Add these preferences to the application's `config.xml` before installing or preparing the plugin, keeping a higher deployment target if the app already has one:

```xml
<platform name="ios">
  <preference name="deployment-target" value="15.0" />
  <preference name="SwiftVersion" value="5.0" />
</platform>
```

Install this version from your Cordova application:

```sh
cordova plugin add cordova-plugin-chooser@2.0.0-rc.2
```

Installing the npm package alone does not provide a standalone web or Node.js picker. See [platform setup](docs/PLATFORMS.md) for build requirements and provider behavior, and [known issues](docs/KNOWN-ISSUES.md) for the unresolved iOS Files simulator failures.

## Quick start

This example reads and parses a JSON document up to 1 MiB using direct data:

```html
<button id="choose-file" type="button" disabled>Choose JSON</button>
<p id="selection" role="status"></p>
<script src="cordova.js"></script>
<script src="app.js"></script>
```

In `app.js`:

```js
document.addEventListener('deviceready', () => {
  const button = document.getElementById('choose-file');
  const output = document.getElementById('selection');
  button.disabled = false;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const file = await chooser.getFileData({
        accept: 'application/json',
        maxFileSize: 1024 * 1024,
        format: 'text'
      });
      output.textContent = JSON.stringify(JSON.parse(file.text));
    } catch (error) {
      if (error instanceof chooser.CancellationError) {
        output.textContent = 'Selection canceled.';
      } else if (error instanceof chooser.CleanupError) {
        output.textContent = 'File cleanup failed. See the console for the read outcome.';
        console.error(error.outcome, error.failures);
      } else {
        output.textContent = 'Could not read the JSON document.';
        console.error(error);
      }
    } finally {
      button.disabled = false;
    }
  });
});
```

Call browser pickers directly from a user interaction. Picker cancellation rejects with `CancellationError`. If cleanup also fails, `CleanupError.outcome` preserves the completed result or original error; handle cleanup separately from the operation.

## Choose a method

| Need | One file | Multiple files |
| --- | --- | --- |
| Managed file with reading methods and a temporary URI | `getFile(options)` | `getFiles(options)` |
| Managed file for the duration of a function | `withFile(options, consume)` | `withFiles(options, consume)` |
| Names, types, and reported sizes without reading contents | `getFileMetadata(options?)` | `getFilesMetadata(options?)` |
| Complete contents in an explicit format | `getFileData(options)` | `getFilesData(options)` |

Set `source: 'photos'` to choose images or videos; the default is documents. Native managed files are private cache copies. Browser managed files retain the selected `File` and a Blob URL. Release managed files when every consumer has finished; metadata and direct-data results have no release obligation.

Managed and direct-data selection require a per-file byte limit; plural calls also require an aggregate limit. Use a positive integer, or explicit `null` for unlimited. Whole-file reads have their own memory budget. Streams and range reads let the app process a managed file incrementally.

## Documentation

- [API reference](docs/API.md): options, results, reading, cancellation, errors, and TypeScript 5.7+.
- [File handling](docs/FILE-HANDLING.md): streaming, scoped cleanup, storage, URI consumers, and parsing.
- [Platform guide](docs/PLATFORMS.md): document and photo pickers, setup, permissions, and lifecycle.
- [Migration](docs/MIGRATION.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [known issues](docs/KNOWN-ISSUES.md).
- [Contributing](CONTRIBUTING.md), [verification](docs/VERIFICATION.md), and [changelog](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for licensing and contributor notices.
