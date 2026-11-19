<a id="migrating-from-132-to-20"></a>

# Migrating to 2.0.0-rc.2

RC2 changes how selection, cancellation, and resource ownership work. Check the installed version with `npm ls cordova-plugin-chooser` before changing application code. The main steps below convert a 1.x application.

## Update the installation

For new applications, install `cordova-plugin-chooser@next`. Stable 2.0.0 is expected very soon, pending further testing and validation.

### Capacitor

Upgrade the app to Capacitor 8.x, update the dependency, and rebuild your web assets before syncing the native project.

```sh
npm install cordova-plugin-chooser@next
npm run build
npx cap sync
npx cap ls
```

### Cordova

Before installing RC2 in a Cordova iOS app, explicitly set the deployment target to at least iOS 15. The project is tested in Swift 5 language mode, which the host may already select. See [build configuration](PLATFORMS.md#build-configuration), then replace the installed plugin and prepare the app.

```sh
cordova plugin remove cordova-plugin-chooser
cordova plugin add cordova-plugin-chooser@next
cordova prepare
cordova plugin ls
```

RC2 supports Cordova Android 14/15 and iOS 7/8. The plugin requires a deployment target of at least iOS 15 and is tested in Swift 5 language mode. Chooser no longer needs `cordova-plugin-add-swift-support`. Remove it only if no other plugin uses it. RC2's declarations require TypeScript 5.7 or newer.

<a id="existing-calls"></a>

## Replace earlier calls

| Earlier application code | RC2 approach |
| --- | --- |
| `getFile(accept)` for bytes and a data URI | `getFileData({accept, maxFileSize, format: 'bytesAndDataURI'})` |
| `getFileMetadata(accept)` | `getFileMetadata({accept})` |
| Success and failure callbacks | Await the Promise or attach Promise handlers |
| Cancellation resolves to `undefined` | Catch `CancellationError` |

RC2 expects options objects. Bare MIME strings, callback arguments, and unknown keys reject. `getFile` now returns a managed handle rather than eager `data` and `dataURI`. Select a direct-data format when a whole-file representation is needed. Formats include `bytes`, `text`, `dataURI`, `bytesAndDataURI`, `blob`, and `arrayBuffer`.

<a id="multiple-selection-and-large-files"></a>

RC1 users also need to replace its plural eager-data calls with `getFilesData` and its `getFileUri` / `getFilesUri` calls with managed `getFile` / `getFiles`. RC1's `localOnly` option becomes `preferLocal`, and its omitted or zero unlimited byte limits must become explicit `null`. Surviving RC1 native managed IDs remain releasable. The other changes on this page apply to RC1 as well.

## Make budgets explicit

Set a positive `maxFileSize` on managed and direct-data pickers. Plural versions also require `maxTotalSize`. Pass explicit `null` only if the application accepts an unlimited size. Omitted and zero byte limits are no longer unlimited. `maxFiles` is optional on plural methods and takes a positive count or `null`.

```js
const file = await chooser.getFileData({
  accept: 'application/json',
  maxFileSize: 1024 * 1024,
  format: 'text'
});
const value = JSON.parse(file.text);
```

Whole-file methods on a managed handle require a separate `maxBytes`. Use a range or stream for incremental processing when a complete result would be too large for memory. Text operations accept `encoding` and `fatal` at the top level. Metadata does not take byte limits and does not bridge complete contents, although the provider or OS may still copy or download a file.

Android now allows remote document providers by default, including for single-file metadata. Use `preferLocal: true` as a provider hint when needed.

## Handle cancellation and cleanup

RC2 rejects on picker dismissal and on signal cancellation. `CancellationError.reason` distinguishes `'picker'` from `'signal'`, and cancellation caused by a supplied signal preserves its reason in `cause`. Pass a signal to each later read that should also be abortable.

```js
try {
  const name = await chooser.withFile(
    {maxFileSize: 10 * 1024 * 1024},
    file => file.name
  );
  console.log(name);
} catch (error) {
  if (error instanceof chooser.CancellationError) {
    // Selection was dismissed or aborted.
  } else if (error instanceof chooser.CleanupError) {
    console.error('Cleanup failed', error.failures, error.outcome);
  } else {
    console.error(error);
  }
}
```

Scoped helpers wait for their consumer and release the selected files afterward. If cleanup fails, `CleanupError.outcome` keeps the completed value or original error. Check that outcome before retrying an operation with side effects. See [file handling](FILE-HANDLING.md#consume-then-release).

## Update ownership and result fields

Managed results alone have an `id`, `uri`, read methods, and a release obligation. Metadata and direct-data results do not retain a managed Blob URL or ID in RC2. An optional `sourceUri` is borrowed and is not a managed reference. On iOS, metadata still uses an import that may copy or download a whole file outside byte budgets. Its URI can refer to the temporary import rather than the original location.

Use `file.release()`, `releaseFile(id)`, or `releaseFiles(ids)` after all consumers finish. Restored handles for one ID share the same resource. Save the complete `file.toJSON()` reference if later restoration is useful, but do not treat an evictable cache as persistent storage. Browser references do not survive loss of the page registry.

## Add photo-library selection

Use `source: 'photos'` and optionally `mediaTypes: ['image']` or `['video']` for library selection. Document selection remains the default. Library selection does not provide camera capture, editing, or a guarantee of original encoded bytes. The system picker and fallback vary by platform.

## Framework and lifecycle integration

Capacitor registers RC2 as a native plugin. Replace references to `window.chooser` with this import and register your UI handlers when the UI mounts. Remove any Chooser startup dependency on Cordova's `deviceready`.

```ts
import { Chooser } from 'cordova-plugin-chooser/capacitor';
```

In Cordova, continue to use the injected global after `deviceready`. See [TypeScript setup](API.md#typescript).

### Awesome Cordova Plugins and fork-specific wrappers

The Awesome Cordova Plugins Chooser wrapper [changed to the MaximBelov fork](https://github.com/danielsogl/awesome-cordova-plugins/commit/ba37646fc4b7cc86b497affa0ef932ad374b9080). Its `mimeTypes`, `path`, `displayName`, and `mimeType` interface differs from this package's `accept`, `name`, and `mediaType`. A cast or copied type declaration cannot translate the runtime contract. Call this package's injected global or use a wrapper that explicitly supports its RC2 API.

### Android lifecycle

A destroyed WebView loses the pending Promise. Cordova can deliver a raw native envelope in `resume.pendingResult`, but it is not the public managed or data result and does not resume JavaScript work. Capacitor reports an interrupted picker through its restored-result event. See [restored Android results](PLATFORMS.md#restored-android-results).

## Check the application upgrade

Exercise selection and dismissal, limits, decoding, provider access, immediate reopening, cleanup, and cache eviction with the app's own devices and providers. Confirm all URI consumers finish before release. Review the [iOS Files issue](KNOWN-ISSUES.md) when qualifying document selection.
