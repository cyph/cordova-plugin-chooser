# Cordova Plugin Chooser

Choose files from Android's document picker, iOS Files, or a browser file input. Read file contents, inspect metadata, or use temporary references for larger files.

**This checkout prepares `2.0.0-rc.1`; it is not published to npm.** npm `1.3.2` does not include the new multiple-selection and managed-reference methods. For that release, use its [versioned documentation](https://github.com/cyph/cordova-plugin-chooser/blob/12863c700b2ff29c51e6755ff92b11a61e568f9b/README.md). Upgrading applications should read the [migration guide](docs/MIGRATION.md).

## Install

For the published release, run this in your Cordova application:

```sh
cordova plugin add cordova-plugin-chooser
```

To try the candidate APIs documented here, install the public candidate branch:

```sh
cordova plugin add https://github.com/cyph/cordova-plugin-chooser.git#candidate/2.0.0
```

The candidate branch can move. For reproducible evaluation, replace `candidate/2.0.0` with the full commit SHA you reviewed, or install a local checkout of that revision. Installing a Git candidate does not require an npm prerelease to exist.

The plugin exposes the global `chooser` after `deviceready`. TypeScript declarations are included. The package is a Cordova bridge, not a standalone Node.js picker. Applications do not need chainman to use it.

## Choose a method

| Need | One file | Multiple files | Result |
| --- | --- | --- | --- |
| Read contents into JavaScript | `getFile()` | `getFiles()` | Metadata, `Uint8Array` and base64 data URI |
| Inspect names, types and sizes | `getFileMetadata()` | `getFilesMetadata()` | Metadata without loading contents in plugin code |
| Handle large files through references | `getFileUri()` | `getFilesUri()` | Metadata and a managed temporary URI |

All picker methods return a Promise and also accept callbacks. Canceling resolves to `undefined`. Multiple-selection methods return an array even when one file is selected. Use `releaseFile(id)` when finished with a managed reference; browser results from every method have an ID to release.

## Quick start

Add a button and a place to show the selection:

```html
<button id="choose-file" disabled>Choose a file</button>
<p id="selection"></p>
```

Load this from your app's JavaScript after including `cordova.js`:

```js
document.addEventListener('deviceready', () => {
  const button = document.getElementById('choose-file');
  const selection = document.getElementById('selection');
  button.disabled = false;

  button.addEventListener('click', async () => {
    button.disabled = true;
    let file;
    try {
      // Invoke directly from the click handler for browser compatibility.
      file = await chooser.getFileMetadata('image/*,application/pdf');
      selection.textContent = file
        ? `${file.name} (${file.size === null ? 'unknown size' : file.size + ' bytes'})`
        : 'No file selected';
    } catch (error) {
      selection.textContent = String(error);
    } finally {
      try {
        if (file?.id) await chooser.releaseFile(file.id);
      } catch (error) {
        console.error('Could not release the file reference', error);
      } finally {
        button.disabled = false;
      }
    }
  });
});
```

MIME filters are picker hints. Validate content before relying on its type. A file name or reported size is provider metadata, not a guarantee.

## Compatibility

The maintained platform families and their platform-defined OS floors are:

| Cordova platform | OS requirement |
| --- | --- |
| Android 14.x / 15.x | Android 7.0 / API 24 or later |
| iOS 7.x | iOS 11 or later |
| iOS 8.x | iOS 13 or later |
| Browser | Current Chrome, Edge, Firefox or Safari with file-input `cancel`, FileReader, Blob URLs and Web Crypto |

See Cordova's [Android requirements](https://cordova.apache.org/docs/en/latest/guide/platforms/android/) and [iOS requirements](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) for application build prerequisites. The [verification guide](docs/VERIFICATION.md) describes automated coverage and checks that need a device or provider. A successful build does not establish every OS/provider combination.

The current Apple build lane uses Xcode 26.3, iOS SDK 26.2 and an iOS 15.0 deployment target. That target follows the [selected Xcode's supported deployment range](https://developer.apple.com/xcode/system-requirements) and is higher than Cordova's historical OS floors above. Source fallbacks for older OS versions remain, but this lane does not qualify builds targeting iOS 11–14.

The plugin adds no blanket storage/media permissions and needs no separate Swift-support plugin. On iOS it selects regular documents through Files; it does not provide a camera or Photos-library UI.

For iOS, set these preferences in your application's `config.xml` to match the current build lane:

```xml
<platform name="ios">
  <preference name="SwiftVersion" value="5.0" />
  <preference name="deployment-target" value="15.0" />
</platform>
```

The iOS package includes `ChooserPrivacy.bundle/PrivacyInfo.xcprivacy`. It declares file-timestamp API use with reason `C617.1` for inspection of the plugin's app-private cache. The plugin does not track users or collect data off-device. Its resource bundle leaves your app's privacy manifest intact; your app remains responsible for declarations covering its own data handling and other dependencies. See Apple's [required-reason API guidance](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).

## Documentation

- [API reference](docs/API.md): methods, callbacks, TypeScript, results and options.
- [Migration from 1.3.2](docs/MIGRATION.md): platform requirements and new resource ownership.
- [File handling and troubleshooting](docs/FILE-HANDLING.md): large files, cleanup, cloud providers and lifecycle behavior.
- [Contributing](CONTRIBUTING.md): setup and implementation conventions.
- [Verification and dependency maintenance](docs/VERIFICATION.md): chainman commands and CI coverage.
- [Changelog](CHANGELOG.md): release candidate changes.

Apache-2.0 licensed. See [LICENSE](LICENSE), [NOTICE](NOTICE) and Git history for contributor attribution.
