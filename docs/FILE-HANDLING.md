# File handling and troubleshooting

## Large files and storage

Use `getFileUri()` or `getFilesUri()` when a file may be large. Native implementations stream into generated files in a dedicated app-private cache directory. Contents do not cross the JavaScript bridge. This bounds the copy buffer, not total disk usage or provider execution time. Set file-count, per-file and aggregate limits for your application's needs.

Data methods read complete contents, transfer base64 through the bridge, and expose both a data URI and decoded bytes. Base64 adds roughly one third to the encoded length, and multiple representations coexist in memory. Large files or batches can exhaust memory or cause OS termination. Inspecting metadata first cannot enforce a reliable limit because reported sizes can be unknown or inaccurate.

Native copies consume additional app storage. Providers may also download/import files into their own temporary storage. A copy is a snapshot, not a link to future edits. Filesystem exhaustion causes an error and attempted cleanup; abrupt termination or deletion failure can leave cache entries until recovery or eviction.

Browser URI methods create Blob URLs referencing File objects, without a native filesystem copy or FileReader content read. Consumers that later convert a Blob to an ArrayBuffer or base64 still incur that allocation.

## Consume, then release

Release after every consumer finishes. For multiple results, attempt every release even if one fails:

```js
async function withSelectedFiles(consumeFiles) {
  const files = await chooser.getFilesUri({
    maxFiles: 5,
    maxFileSize: 20 * 1024 * 1024,
    maxTotalSize: 50 * 1024 * 1024
  });
  if (files === undefined) return;

  try {
    await consumeFiles(files);
  } finally {
    const releases = await Promise.allSettled(
      files.map(file => chooser.releaseFile(file.id))
    );
    releases.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error('Could not release a file reference', result.reason);
        // Keep files[index].id if your app will retry cleanup.
      }
    });
  }
}
```

`consumeFiles` is supplied by your application. Invoke `withSelectedFiles` directly from a click handler in browsers and handle its returned Promise's rejection. The consumer must resolve only when finished with the references.

On Android/iOS, pass the private `file:` URI to a native-capable reader or uploader accepting local file URIs. Ordinary WebView `fetch()` is not a portable way to read it. Sharing it with another app requires the platform's sharing mechanism. This plugin does not provide uploading or cross-app sharing.

In a Cordova browser app, a managed `blob:` URL can be fetched while alive. After `deviceready`, invoke this from a click handler and handle its returned Promise's rejection:

```js
async function inspectBrowserFile() {
  const file = await chooser.getFileUri();
  if (file === undefined) return;
  try {
    const response = await fetch(file.uri);
    if (!response.ok) throw new Error('Could not open the selected Blob');
    const blob = await response.blob();
    console.log(file.name, blob.size, blob.type);
  } finally {
    await chooser.releaseFile(file.id);
  }
}
```

This example is browser-only. For small files on every platform, `getFile()` provides a `Uint8Array`; browser results still need release by ID when no longer needed.

## Reference lifetimes

| Result | Ownership and lifetime |
| --- | --- |
| Native data/metadata URI | Provider or OS controlled; no persistent grant is promised. No managed ID to release. |
| Native copy URI | Plugin-owned app-private cache file, usable until release, OS/app cache eviction, or app removal. |
| Browser URI from any method | Plugin-owned Blob URL, usable until release or `pagehide`. |

Treat IDs as opaque. Store the returned name and MIME type separately when needed: generated native filenames have no useful extension. Never build a cache path from `name` or attempt release by parsing a URI.

Native successful copies can survive an app restart, but cache is not durable storage. Copy important data into storage your application owns using an appropriate native API. Interrupted batches are recovered when a later copy starts; there is no promise of background completion or a result callback after process death.

Browser navigation, including entry into the back/forward cache, revokes managed URLs. Do not persist browser IDs or URLs for reuse after returning to the page. Releasing a URL does not erase bytes already loaded into JavaScript memory.

## Providers and filtering

Android uses document providers and content URIs. Original single-file data/metadata methods prefer local files; multiple and URI methods allow remote providers, and URI methods accept `localOnly`. Providers may require authentication, connectivity, downloads or export conversion. The plugin cannot force cloud-native documents to be available offline or exported in a particular format.

On iOS, data/metadata selection may cause the OS to import a file. Access to an original provider URI is not guaranteed after the operation ends. Directories and file packages are outside the regular-file contract; Photos and camera access need another integration.

MIME filters and names are hints. Providers and OS versions may offer different matching documents, and unknown types may broaden selection. Validate contents in the component that consumes them. Render names using text APIs such as `textContent`, and choose application-controlled names when writing elsewhere.

## Lifecycle and troubleshooting

| Symptom | What to check |
| --- | --- |
| `chooser` is undefined | Install the plugin, prepare/rebuild, and wait for `deviceready`. |
| Browser picker does not open | Invoke directly from a user event handler before other asynchronous work. Use a browser supporting file-input cancellation. |
| `BUSY` | Wait for the existing request. Android retains an outstanding picker's reservation after WebView reset until its activity result returns. |
| iOS picker will not present | Finish dismissing another modal; check supported orientations on iPhone and iPad. |
| `size` is `null` or wrong | Metadata is optional and may be stale. Use a URI method with streaming limits. |
| Native URI cannot be fetched in JavaScript | Use a native-capable consumer, or `getFile()` for a suitably small file. |
| Browser URL stops working | Release and navigation revoke it; select again. |
| Cloud selection stalls or fails | Check provider connectivity/account state and try a local file. Cancellation is best effort. |
| Copy fails near a limit or on a full device | Check actual byte limits and cache storage; failed batches return no usable references. |

Reset requests provider cancellation and abandons callback ownership. An uncooperative read can delay cleanup until it returns. iOS permits at most two outstanding file workers across plugin instances, including abandoned reads; further requests can remain busy until one finishes.

If Android kills the app while a picker is open, the original JavaScript Promise is gone. Cordova may deliver the restored native result through `resume`'s `pendingResult`. This is Cordova's raw result channel, not a replay through the JavaScript wrapper: account for the original operation and deserialize/normalize accordingly. See [Cordova's lifecycle guide](https://cordova.apache.org/docs/en/latest/guide/platforms/android/#lifecycle-guide) and the [manual fixture](../tests/fixture-app/www/app.js). Interrupted processing is not a durable background job.

For a reproducible issue, include the plugin revision, Cordova platform version, OS/browser, method/options, provider type and a minimal nonprivate sample. Avoid personal files, tokens, file contents or sensitive URIs in public reports.
