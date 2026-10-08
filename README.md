# Chooser

Choose regular files using the system document picker in Cordova, or a file input in the browser.

**Unreleased:** the published `1.3.2` package predates the new methods described here. Install this checkout to use them. See the [verification guide](docs/VERIFICATION.md) for development checks.

## Installation and compatibility

Install this checkout into a Cordova application:

```sh
cordova plugin add /absolute/path/to/cordova-plugin-chooser
```

After a release containing these changes, the normal registry installation is:

```sh
cordova plugin add cordova-plugin-chooser
```

Use the global `chooser` after `deviceready`. Cordova provides the JavaScript bridge; this package is not a standalone Node.js file picker. TypeScript declarations are included; remove conflicting ambient declarations from older wrappers if necessary.

| Platform | Intended support | OS/API fallback |
| --- | --- | --- |
| Cordova Android 14.x | Previous platform generation | Android 7.0 / API 24 and later; platform targets API 35 |
| Cordova Android 15.x | Current platform generation | Android 7.0 / API 24 and later; platform targets API 36 |
| Cordova iOS 7.x | Previous platform generation | iOS 11 and later |
| Cordova iOS 8.x | Current platform generation | iOS 13 and later |
| Cordova browser | Current Chrome, Edge, Firefox and Safari | File input `cancel` event, FileReader, Blob URLs and Web Crypto |

This is a support target, not a tested compatibility claim. See the official [Android](https://cordova.apache.org/docs/en/latest/guide/platforms/android/) and [iOS](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) requirements. Plugin engine declarations set minimum versions; future majors are not automatically part of this support policy.

Cordova handles Swift integration. Do not add `cordova-plugin-add-swift-support` for this plugin. The picker needs no blanket storage, media-library or photo-library permissions, no custom FileProvider and no `android:largeHeap` setting. Android uses document-provider grants. iOS uses modern type identifiers on iOS 14+, with the older document-picker and type-identifier fallbacks below that.

## Choose an API

All picker methods return a Promise, accept optional success/failure callbacks, and resolve to `undefined` on cancellation. A successful multiple selection returns a nonempty array, even for one file.

| Method | Successful result | Contents in the bridge | Owned resource |
| --- | --- | --- | --- |
| `getFile(accept?)` | `FileData` | Base64, decoded to bytes in JS | Browser Blob URL only |
| `getFileMetadata(accept?)` | `FileMetadata` | No file contents | Browser Blob URL only |
| `getFiles(accept?)` | `FileData[]` | Base64 for every file | Browser Blob URLs only |
| `getFilesMetadata(accept?)` | `FileMetadata[]` | No file contents | Browser Blob URLs only |
| `getFileUri(options?)` | `FileReference` | No file contents | Private native copy / browser Blob URL |
| `getFilesUri(options?)` | `FileReference[]` | No file contents | Private native copies / browser Blob URLs |
| `releaseFile(id)` | `void` | No file contents | Releases that managed resource |

`accept` is a comma-separated MIME string, for example `"image/*,application/pdf"`. Omitted/empty filters mean `"*/*"`. MIME filtering is a picker hint: providers can ignore it, misidentify files, or export cloud documents in another format. Validate content in your application.

### Results

Every file has:

- `name: string`: provider display name, including its extension when supplied.
- `mediaType: string`: descriptive MIME type; fallback `application/octet-stream`.
- `uri: string`: platform-specific reference; see ownership below.
- `size: number | null`: bytes. Metadata sizes are provider-reported and may be unknown or inaccurate. Data/copy results count the contents actually read.
- `id?: string`: all browser results include an opaque ID for releasing their Blob URL.

`FileData` also has `data: Uint8Array` and `dataURI: string`. Base64 padding is preserved without adding bytes to the decoded file. Empty files produce an empty byte array and an empty, valid base64 payload.

`FileReference` has a required `id`, an exact numeric `size`, and a native-only `sourceUri` identifying the original selection. Its `uri` points to the managed copy, not to the original.

Names and MIME types are untrusted metadata. Use text rendering for names and never concatenate them into filesystem paths.

### Single-file data and metadata

```js
document.addEventListener('deviceready', function () {
  document.getElementById('choose').addEventListener('click', async function () {
    try {
      const file = await chooser.getFile('text/csv,text/plain');
      if (!file) return; // Canceled.
      const text = new TextDecoder('utf-8').decode(file.data);
      console.log(file.name, text); // CSV/JSON parsing belongs to your application.
      if (file.id) await chooser.releaseFile(file.id); // Browser Blob URL.
    } catch (error) {
      console.error('Could not choose a file:', error);
    }
  });
});
```

For a metadata-only request, use `await chooser.getFileMetadata('application/pdf')`. It returns no `data` or `dataURI` and never loads the whole file into plugin memory. iOS may still download/import the document through the system picker; metadata-only does not promise zero network or disk activity.

### Multiple selection

```js
const files = await chooser.getFiles('image/*');
if (files) {
  for (const file of files) {
    console.log(file.name, file.data.byteLength);
    if (file.id) await chooser.releaseFile(file.id);
  }
}

const metadata = await chooser.getFilesMetadata();
if (metadata) {
  for (const file of metadata) {
    console.log(file.name, file.size);
    if (file.id) await chooser.releaseFile(file.id);
  }
}
```

Run each picker call from its own user action in browsers. Native selection preserves provider order and removes duplicate URIs. Some providers offer only single selection; the result still has the requested array shape. A batch fails as a whole if any file cannot be processed.

### Large files and managed references

Prefer the URI methods when file size is large or unknown. Native copies use a fixed 64 KiB I/O buffer on a background worker and do not encode file contents through the bridge.

```js
const reference = await chooser.getFileUri({
  accept: 'application/pdf,video/*',
  maxFileSize: 500 * 1024 * 1024, // Per file, in bytes.
  localOnly: false               // Android only; allow remote providers.
});
if (reference) {
  try {
    // Supply your application's native uploader/file consumer here.
    // It must accept an app-private file:// URI; browser fetch is not
    // a portable way to read a native file URL.
    await uploadFromNativeFileUri(reference.uri, reference.name, reference.mediaType);
  } finally {
    await chooser.releaseFile(reference.id);
  }
}
```

`uploadFromNativeFileUri` above is an application-provided function, not part of this plugin. A URI is not a promise that another app or a webview can read it. On Android, sharing outside your app requires a separate correctly scoped sharing component.

`getFilesUri(options)` returns an array of the same references. Release every ID after consumption:

```js
const references = await chooser.getFilesUri({
  accept: '*/*',
  maxFileSize: 500 * 1024 * 1024,
  maxFiles: 10,
  maxTotalSize: 1024 * 1024 * 1024
});
if (references) {
  try {
    for (const reference of references) {
      await uploadFromNativeFileUri(reference.uri, reference.name, reference.mediaType);
    }
  } finally {
    // Attempt every release even if one deletion fails.
    await Promise.all(references.map(reference => chooser.releaseFile(reference.id)));
  }
}
```

Copy options are optional; a MIME string is also accepted:

```js
const pdf = await chooser.getFileUri('application/pdf');
if (pdf) {
  console.log(pdf.name, pdf.uri);
  await chooser.releaseFile(pdf.id);
}
```

In real code, retain the returned reference before doing other work. Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `accept` | `"*/*"` | MIME filter hint |
| `maxFileSize` | `0` | Nonnegative safe-integer byte limit per file; omitted/zero means unlimited |
| `maxFiles` | `0` | Nonnegative safe-integer selection count limit; omitted/zero means unlimited |
| `maxTotalSize` | `0` | Nonnegative safe-integer byte limit across the selection; omitted/zero means unlimited |
| `localOnly` | `false` | Android only: ask the picker to exclude remote providers |

All three limits apply to both copy methods. `maxFiles` is checked after selection normalization and native URI deduplication, before content reads. Positive byte limits are enforced while streaming, independent of provider size metadata. The browser uses each selected File's byte size. Per-file and aggregate limits apply together: exact limits and empty files are valid, but an exhausted aggregate budget cannot admit another nonempty file. Any limit failure rejects the entire batch and rolls back its copies. Limits reset for each request; they do not cap resources retained from earlier requests.

Legacy data methods intentionally retain their unlimited, whole-file behavior. Native buffers, base64 strings, JSON transport and JS byte arrays can coexist in memory; multiple selection compounds the cost. Android attempts to report OOM, but allocation failure or OS process termination can prevent any callback. iOS allocation termination cannot be reliably caught. Use URI methods to avoid this cost.

### Callbacks and TypeScript

These forms work for each picker method:

```js
chooser.getFile(success, failure);
chooser.getFile('image/*', success, failure);
chooser.getFileMetadata(undefined, success, failure);
chooser.getFilesMetadata(success, failure);
chooser.getFileUri({maxFileSize: 1024 * 1024}, success, failure);
chooser.getFilesUri(success, failure);
chooser.releaseFile(reference.id, () => console.log('Released'), failure);
```

Success receives the result or `undefined` for cancellation. The returned Promise has the same result. Exceptions/rejections from an application callback are reported separately and do not change that Promise's selected file. Handle operation failures using a failure callback or the returned Promise.

```ts
import chooser = require('cordova-plugin-chooser');

async function select(): Promise<chooser.FileReference | undefined> {
  return chooser.getFileUri({accept: 'application/pdf'});
}
```

The import requires a Cordova-aware bundler/runtime. For a global-only app, use `/// <reference types="cordova-plugin-chooser" />` and the global `chooser` instead.

## Ownership, cleanup and lifetime

**Native copies:** generated UUID filenames live under the app's private cache directory in `cordova-plugin-chooser/`. Provider names never select the destination. Files have no guaranteed extension; pass `name` and `mediaType` to consumers separately. Copying consumes additional storage equal to the file size, plus possible provider download/import storage. A copy snapshots the contents read and does not modify or move the source.

Keep the opaque `id` for `releaseFile(id)`. Native IDs can be retained across app restarts while their cache entries still exist. Release accepts only managed IDs and can remove only regular files in the plugin cache; paths, source URIs and symlinks are rejected. Releasing a valid missing ID is idempotent. Failed requests/batches attempt to delete every created copy. Native batches first write into a private `.pending` staging directory. A journal records generated IDs before promotion into the existing cache layout; references are returned only after the whole batch commits. Before the first copy in each app process, recovery removes abandoned staging and uncommitted promotions while preserving committed references. Cleanup and release use a separate cache queue, so they do not wait behind unrelated provider reads.

Recovery cannot atomically couple a filesystem commit to JavaScript receipt. If the app dies after committing but before delivering the result, committed copies can remain without the caller knowing their IDs. Disk errors, lost/corrupt journals or abrupt storage loss can also leave cache entries. Cleanup diagnostics omit paths, names and contents; unsafe or unrecognizable entries are retained instead of guessed at. This is process-interruption recovery for disposable cache data, not a durable storage transaction. The plugin cache is managed within one app process; sharing it with another process or extension is unsupported.

The OS may evict cache files at any time. Copy into application-owned durable storage if persistence is required. A successful result does not guarantee later availability. Release does not delete original provider files or revoke their grants.

**Native data/metadata results:** their source/import URIs have provider- or OS-controlled lifetimes. They are not managed copies and have no releasable native ID. Android content grants are temporary; iOS security-scoped access is balanced around the read. Do not depend on the returned source URI remaining readable. Select again with a URI method if you need a plugin-managed copy.

**Browser results:** every result holds a managed Blob URL, including data and metadata methods. Release its ID after use. Blob URLs last only in the current document and are all revoked on `pagehide`, including when entering the back/forward cache. IDs do not survive navigation/reload. The URI methods retain a File/Blob reference rather than making a second disk copy; browser storage and memory accounting are implementation-dependent. Use browser Blob APIs to consume these references.

## Cancellation, errors and platform behavior

Cancellation resolves successfully to `undefined`; it does not reject. Empty browser selections do the same. A second picker request while selection/processing is pending rejects with `BUSY`; it cannot replace the first callback. There is no public programmatic cancellation method.

Errors may be native strings or JavaScript Error objects. Descriptive prefixes include `INVALID_ARGUMENT`, `PICKER_FAILED`, `READ_FAILED`, `READ_INTERRUPTED`, `FILE_TOO_LARGE`, `TOO_MANY_FILES`, `TOTAL_SIZE_EXCEEDED`, `CACHE_FAILED`, `COPY_FAILED`, `RELEASE_FAILED` and `OUT_OF_MEMORY`. Provider errors can retain platform-specific messages; do not parse them as a stable machine-readable error schema.

On reset/dispose, pending native work loses callback ownership. Android requests cancellation of provider queries and descriptor opens; iOS cancels the request's file coordinator. Streaming and promotion loops also check for reset. Provider cancellation is best effort: a provider can ignore the signal, and already-running reads or coordinated access can still block. Abandoned copies are cleaned after that work returns. A destroyed JS context cannot receive its old Promise result.

Android retains its picker reservation after reset until the outstanding activity result returns. A new request receives `BUSY` during that interval. An abandoned picker restored after activity recreation reports cancellation without reading its selection. On iOS, each request has an independent file worker; an abandoned blocked read does not serialize the next request. At most two requests may hold workers across plugin instances, including abandoned reads. Further requests receive `BUSY` until a worker actually finishes. Reset cannot forcibly interrupt an uncooperative provider.

Android saves outstanding picker options for Cordova activity-result restoration. If Android kills the app while the picker is open, the original JS Promise is gone. Cordova delivers the replacement result through the `resume` event's `pendingResult`; see [Android lifecycle guidance](https://cordova.apache.org/docs/en/latest/guide/platforms/android/#lifecycle-guide) and the [fixture app](tests/fixture-app/www/app.js). Processing already underway at process death is not a durable background job.

The original Android single-file methods retain their local-only picker preference. New multiple/copy methods allow remote providers; copy methods also offer `localOnly`. Google Drive and other providers may require downloads, authentication, connectivity or export conversion. The plugin cannot force a provider to supply offline files or preserve a cloud-native document format.

On iOS, this is the Files/document-provider picker. Photos-library browsing, camera capture, directories and file packages are outside its regular-file contract. Older OS/provider registrations may present different available types. Existing app modals must finish before presenting a new picker.

Browsers require a direct user gesture. Call the method in the click handler before awaiting other work. Cancellation requires a browser implementing the file input `cancel` event; older browsers are outside the browser support target.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution practices and [docs/VERIFICATION.md](docs/VERIFICATION.md) for development checks. Attribution is retained in Git history and [NOTICE](NOTICE).

Apache-2.0; see [LICENSE](LICENSE).

## Development

Run `just setup`, then `just verify` for the shared JavaScript, typings, packaging and browser gate. Chainman owns the pinned environments and dependency updates. Android and iOS build lanes are separate commands and release requirements; see [verification and dependency maintenance](docs/VERIFICATION.md) and [contributor guidance](CONTRIBUTING.md).
