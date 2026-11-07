# Migrating to 2.0.0-rc.2

RC2 makes managed files the default and moves complete-data reads into explicitly named methods. It also changes cancellation to an exception, requires byte budgets, adds Photos selection, and removes callback overloads. These changes apply to applications upgrading from both RC1 and 1.x.

RC1 was published on November 6, 2026. It retained the earlier call forms while adding multiple selection, managed URI methods, browser support, and types. Its release notes and contributor credits remain in the [changelog](../CHANGELOG.md).

## Update the installation

Use Cordova Android 14/15 or Cordova iOS 7/8. iOS apps must target iOS 15 or later and use Swift 5 language mode. Before installing or preparing RC2, add the preferences shown in [iOS build configuration](PLATFORMS.md#build-configuration), preserving an existing higher deployment target. An absent target now fails preparation.

Replace the previous plugin installation from your Cordova application directory:

```sh
cordova plugin remove cordova-plugin-chooser
cordova plugin add cordova-plugin-chooser@2.0.0-rc.2
```

Prepare and rebuild the application, and review manifest and lockfile changes. Chooser no longer uses `cordova-plugin-add-swift-support`; remove that helper only if no other plugin needs it. Neither document selection nor the new photo picker needs broad Android storage or photo-library permission. TypeScript applications need version 5.7 or later. See the [README](../README.md#installation) for installation requirements.

## Replace earlier calls

| RC1 or 1.x use | RC2 equivalent |
| --- | --- |
| `getFile(accept)` for bytes and data URI | `getFileData({accept, maxFileSize, format: 'bytesAndDataURI'})` |
| `getFiles(accept)` for complete data | `getFilesData({accept, maxFileSize, maxTotalSize, format})` |
| `getFileMetadata(accept)` | `getFileMetadata({accept})` |
| `getFilesMetadata(accept)` | `getFilesMetadata({accept, maxFiles})` |
| `getFileUri(options)` | `getFile(options)` |
| `getFilesUri(options)` | `getFiles(options)` |
| Manual select/use/release in one function | `withFile(options, consume)` or `withFiles(options, consume)` |
| Success/failure callbacks | `await` with `try`/`catch`, or Promise handlers |
| `result === undefined` for cancellation | Catch `chooser.CancellationError` |

Options objects replace bare MIME strings. Callback arguments and unknown options reject. `getFile()` no longer reads the contents into `data` and `dataURI`; it returns a managed handle with reading methods and a temporary URI.

When only one representation is needed, choose `'bytes'`, `'text'`, or `'dataURI'`. Use `'bytesAndDataURI'` to retain the useful RC1 pair without two content reads. For large inputs, choose managed selection and read incrementally.

## Make budgets explicit

Managed and direct-data selection require `maxFileSize`. Plural calls also require `maxTotalSize`. Set positive byte counts, or explicit `null` for unlimited; RC1's omitted/zero unlimited limits are no longer accepted. `maxFiles` is optional, but a supplied value must be positive or `null`.

```js
const file = await chooser.getFileData({
  accept: 'application/json',
  maxFileSize: 1024 * 1024,
  format: 'text'
});
const value = JSON.parse(file.text);
```

Metadata methods accept no byte budgets because they do not materialize contents. Managed whole-file reads require a separate `maxBytes`; a copy allowed onto disk may still be too large to load into memory. Range reads and streams provide incremental access.

Android document methods now allow remote providers by default, including single-file metadata selection. Set `localOnly: true` if the app wants to request the earlier local-provider preference.

## Handle cancellation and cleanup

Picker dismissal and `AbortSignal` cancellation reject with `CancellationError`. Its `reason` distinguishes `'picker'` from `'signal'`. There is no cancellation-related `undefined` result or boolean success flag.

```js
try {
  const name = await chooser.withFile(
    {maxFileSize: 10 * 1024 * 1024},
    file => file.name
  );
  console.log(name);
} catch (error) {
  if (error instanceof chooser.CancellationError) {
    // The user dismissed selection or the operation was aborted.
  } else if (error instanceof chooser.CleanupError) {
    console.error('Cleanup failed:', error.failures);
    console.log('Operation outcome:', error.outcome);
  } else {
    console.error(error);
  }
}
```

A scoped helper preserves the consumer's value or original exception. If cleanup fails, `CleanupError.outcome` records whether the consumer fulfilled or rejected. Do not retry an upload merely because deleting its temporary file failed. See [cleanup handling](FILE-HANDLING.md#consume-then-release).

Pass a signal to each operation that should be abortable. A selection signal does not automatically cancel later reads or a scoped consumer. The helper waits for the consumer to settle before release.

## Update ownership and result fields

Only managed results have `id`, `uri`, reading methods, and a release obligation. Browser metadata and direct-data results no longer retain Blob URLs. Metadata uses optional borrowed `sourceUri` instead of a managed `uri`; direct data likewise has no retained plugin reference.

`file.release()`, `releaseFile(id)`, and `releaseFiles(ids)` share resource ownership. Restoring a saved reference creates another handle to the same resource, not a separate copy. Releasing an ID closes every alias, stops unfinished plugin streams, and waits for started one-shot reads. Wait for external URI consumers yourself.

Save references with `file.toJSON()` and restore them with `restoreFile`. Native cache eviction and browser navigation still invalidate resources. Surviving native RC1 managed IDs remain releasable, but saved cache references are not durable storage.

## Add photo-library selection

Use `source: 'photos'` with optional `mediaTypes: ['image']` or `['video']`. Use the document source for files in Files or other document providers. The photo source adds library selection, not camera capture, editing, or a promise of the original encoded representation. See [platform details](PLATFORMS.md).

## Framework and lifecycle integration

The package includes [TypeScript declarations](API.md#typescript). Wait for `deviceready` and call the injected global directly unless a wrapper explicitly supports this RC2 contract.

### Awesome Cordova Plugins and fork-specific wrappers

The Awesome Cordova Plugins Chooser wrapper [changed to the MaximBelov fork](https://github.com/danielsogl/awesome-cordova-plugins/commit/ba37646fc4b7cc86b497affa0ef932ad374b9080). Its `mimeTypes` input and `path`, `displayName`, and `mimeType` fields do not match this plugin. Installing Chooser does not translate a wrapper's interface.

Use `accept`, `name`, and `mediaType`, and choose a managed or direct-data method explicitly. An object such as `{mimeTypes: 'text/csv', maxFileSize: 1}` rejects because `mimeTypes` is unknown. Copying the wrapper's type declarations or casting to `any` does not repair the runtime call.

### Android lifecycle

A Promise cannot survive WebView destruction. Cordova's `resume.pendingResult` can contain a raw native payload, which is different from the public RC2 result. Review [restored Android results](PLATFORMS.md#restored-android-results) if the application handles activity recreation.

## Check the application upgrade

Exercise selection, cancellation, immediate reopening, limits, decoding, release, cache eviction, and the providers your app uses. Confirm that no consumer outlives scoped cleanup and that cleanup errors cannot repeat completed business operations. Review the [known iOS Files issue](KNOWN-ISSUES.md) when qualifying document selection.
