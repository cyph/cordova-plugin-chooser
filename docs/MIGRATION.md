# Migrating from 1.3.2 to 2.0

Version 2.0.0-rc.1 retains the single-file API and adds multiple selection, URI methods with managed references, browser support, and TypeScript declarations. Start by updating the native plugin, then choose the new methods where your application can use them.

## Update the installation

Use `cordova-android >=14.0.0` or `cordova-ios >=7.0.0`, as applicable. The [platform guide](PLATFORMS.md#requirements-and-coverage) covers OS minimums, build tools, and Swift configuration.

From the Cordova application directory:

```sh
cordova plugin remove cordova-plugin-chooser
cordova plugin add cordova-plugin-chooser@2.0.0-rc.1
```

Review the resulting manifest and lockfile changes and rebuild each native app. Chooser no longer needs `cordova-plugin-add-swift-support`; remove it only if no other plugin needs it. Broad Android storage permissions are not needed for the document picker.

The published 1.3.2 archive identifies itself as `1.3.1` in `plugin.xml`. Check the installed npm package and its source when identifying an older installation. The [changelog](../CHANGELOG.md) preserves the release history.

## Existing calls

`getFile(accept?)` still returns one result containing `data`, `dataURI`, `name`, `mediaType`, and `uri`. `getFileMetadata(accept?)` returns metadata without the data payload. Both return Promises and accept success and failure callbacks, including callback-first calls. Cancellation resolves to `undefined` and passes `undefined` to the success callback. Single-file results do not need array handling.

Results also include `size`: `null` means the provider did not report a size, while `0` reports an empty file. Native metadata methods do not read the whole file in plugin code, although the OS may import or download it. Android's two existing single-file methods continue to prefer local providers.

Data URIs use canonical base64 padding. Remove any application workaround for missing padding, and review literal comparisons of encoded strings. Invalid base64 responses reject. Callback exceptions are reported asynchronously and do not change the picker Promise; handle application errors in callbacks and process each selection once.

## Multiple selection and large files

Use `getFiles()`, `getFilesMetadata()`, or `getFilesUri()` when the rest of the workflow accepts multiple files. On success they return a nonempty array, even for one file; cancellation is still `undefined`.

Data methods read whole files into memory and have no configurable size limits. For large or unknown inputs, use `getFileUri()` or `getFilesUri()` with limits and a consumer that can process the URI without loading the entire file into JavaScript. These methods return references instead of `data` and `dataURI`. On native platforms they stream copies to private cache; in a browser they create managed Blob URLs.

Only URI methods accept copy options. Set `maxFileSize`, `maxFiles`, and `maxTotalSize` as needed: each defaults to `0`, meaning unlimited. Unknown option keys and invalid filters reject. The new multiple and URI methods allow remote Android providers by default; URI methods accept `localOnly: true` to request local providers. See [copy options](API.md#copy-options) and the [consume-and-release example](FILE-HANDLING.md#consume-then-release).

Every browser result has an opaque ID to release. On native platforms only URI results have one. Call `releaseFile(id)` after all consumers finish with a plugin-owned reference, and copy any file you need to keep into persistent app storage. The returned URIs have no persistence guarantee.

## Framework and lifecycle integration

The plugin includes [TypeScript declarations](API.md#typescript). Framework wrappers have their own API and method coverage; check the wrapper you use or call the injected `chooser` global directly after `deviceready`.

### Awesome Cordova Plugins and fork-specific wrappers

The Awesome Cordova Plugins Chooser wrapper [changed to the MaximBelov fork](https://github.com/danielsogl/awesome-cordova-plugins/commit/ba37646fc4b7cc86b497affa0ef932ad374b9080). Its `mimeTypes` and `maxFileSize` arguments and `path`, `displayName`, and `mimeType` result fields describe that fork, not this plugin. Installing this plugin does not translate the wrapper's contract.

For a small CSV, call `chooser.getFile('text/csv')`. For a bounded copy, call `chooser.getFileUri({accept: 'text/csv', maxFileSize: 1024 * 1024})`, consume the returned URI, and release its ID. The [file-handling example](FILE-HANDLING.md#consume-then-release) shows cleanup. Passing an object such as `{mimeTypes: 'text/csv', maxFileSize: 1}` to `getFile()` rejects; use a string filter there and copy options only with URI methods.

### Android lifecycle

When Android recreates an activity, the old Promise cannot receive its result. Cordova may deliver a raw native payload through `resume.pendingResult`. Handle it as described in [restored Android results](PLATFORMS.md#restored-android-results).

## Check the application upgrade

Exercise selection, cancellation, failure, and repeated requests on the platforms and providers your app uses. Check file contents, URI consumers, limits, cleanup, and lifecycle recovery. Review the [iOS known issue](KNOWN-ISSUES.md#intermittent-ios-files-selection) when testing the document picker.
