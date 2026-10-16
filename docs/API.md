# API reference

Use the global `chooser` after `deviceready`. In browsers, invoke a picker directly from a user interaction, before awaiting unrelated work. Only one picker request can be active at a time.

## Methods

| Method | Optional first argument | Promise result |
| --- | --- | --- |
| `getFile` | MIME filter string | `FileData \| undefined` |
| `getFileMetadata` | MIME filter string | `FileMetadata \| undefined` |
| `getFiles` | MIME filter string | `FileData[] \| undefined` |
| `getFilesMetadata` | MIME filter string | `FileMetadata[] \| undefined` |
| `getFileUri` | MIME filter string or `CopyOptions` | `FileReference \| undefined` |
| `getFilesUri` | MIME filter string or `CopyOptions` | `FileReference[] \| undefined` |

Each method supports the same call forms:

```js
chooser.getFile();
chooser.getFile('image/*');
chooser.getFile(onSuccess, onError);
chooser.getFile('image/*', onSuccess, onError);
```

These are alternative examples, not calls to run concurrently. Substitute any picker method from the table; only the first argument and result type change. The success callback receives the same result as the Promise, including `undefined` on cancellation. The failure callback receives the rejection reason. Both callbacks are optional, and callback calls still return a Promise. Choose one style for application processing to avoid handling the same result twice.

An exception or rejected Promise from a callback is reported asynchronously; it does not change the picker Promise's outcome. Handle errors inside asynchronous callbacks when using that style.

Data methods return complete contents in memory. Use them for small files. Metadata methods do not read complete contents in plugin code, but the OS or provider may download/import a file first. URI methods stream a native copy into app-private cache or create a browser Blob URL without transferring contents through the bridge.

For a small UTF-8 text file, call this from your app's selection handler and handle the returned Promise:

```js
async function readSmallTextFile() {
  const file = await chooser.getFile('text/plain');
  if (file === undefined) return;
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(file.data);
  } finally {
    if (file.id) await chooser.releaseFile(file.id);
  }
}
```

There is no byte limit on data methods; choose a URI method when file size is uncertain. A callback-based metadata selection can handle cancellation and browser cleanup this way:

```js
chooser.getFileMetadata('application/pdf', async file => {
  if (file === undefined) return;
  try {
    console.log(file.name, file.size);
  } finally {
    if (file.id) {
      try { await chooser.releaseFile(file.id); }
      catch (error) { console.error('Could not release the reference', error); }
    }
  }
}, error => console.error('Selection failed', error));
```

## Result types

```ts
interface FileMetadata {
  name: string;
  mediaType: string;
  uri: string;
  size: number | null;
  id?: string;
}

interface FileData extends FileMetadata {
  data: Uint8Array;
  dataURI: string;
}

interface FileReference extends FileMetadata {
  id: string;
  size: number;
  sourceUri?: string;
}
```

| Field | Meaning |
| --- | --- |
| `name` | Display name; do not use it as a trusted filesystem path or HTML. |
| `mediaType` | Reported or inferred MIME type; falls back to `application/octet-stream`. |
| `uri` | Source/import URI for native data/metadata results, private `file:` URI for native copies, or `blob:` URL in a browser. |
| `size` | Bytes; metadata can be inaccurate or `null` if unknown. Data/copy results use bytes actually read; browser results use the selected File's size. |
| `id` | Opaque release identifier. Present for native copies and every browser result. |
| `data` | Exact decoded file bytes. Only data methods supply it. |
| `dataURI` | MIME-prefixed, padded base64 data URI. Only data methods supply it. |
| `sourceUri` | Original native provider URI for a copy result. Absent in browsers; not a durable access grant. |

Multiple methods return a nonempty array on success, including for a single selection. Cancellation returns `undefined`, not an empty array. Native duplicate URIs are collapsed; do not rely on provider selection order as a sorted order.

## MIME filters

Omit the filter or pass `'*/*'` for any type. Use a single MIME type, a supported wildcard, or a comma-separated list:

```js
chooser.getFileMetadata('application/pdf');
chooser.getFiles('image/*');
chooser.getFilesMetadata('image/*,application/pdf');
chooser.getFileUri('video/*');
```

These are independent examples. Names such as `.pdf` are extensions, not MIME filters. Native/provider type registrations vary; unknown types may broaden the picker. Validate content independently.

## Copy options

Only `getFileUri` and `getFilesUri` accept an options object:

```ts
interface CopyOptions {
  accept?: string;
  maxFileSize?: number;
  maxFiles?: number;
  maxTotalSize?: number;
  localOnly?: boolean;
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `accept` | `'*/*'` | MIME filter hint |
| `maxFileSize` | `0` | Maximum bytes per file |
| `maxFiles` | `0` | Maximum selected files, after native URI deduplication |
| `maxTotalSize` | `0` | Maximum bytes across the selection |
| `localOnly` | `false` | Android only: ask the picker to exclude remote providers |

Limits must be nonnegative JavaScript safe integers; zero or omission means unlimited. Exact limits are accepted. Native byte limits are enforced while streaming, including when reported sizes are absent or wrong. Browser limits use the File objects' sizes. A limit failure rejects the whole batch and triggers cleanup of resources created for it; no partial array is returned. Cleanup can be delayed by provider I/O or filesystem failure.

```js
const files = await chooser.getFilesUri({
  accept: 'image/*,application/pdf',
  maxFiles: 5,
  maxFileSize: 20 * 1024 * 1024,
  maxTotalSize: 50 * 1024 * 1024
});
```

Keep references until their consumers finish, then release them as shown in [File handling](FILE-HANDLING.md). The original Android single-file data/metadata methods retain their local-only preference; multiple and URI methods allow remote providers by default.

## Release a reference

```ts
declare function releaseFile(id: string, success?: () => void, failure?: (error: unknown) => void): Promise<void>;
```

Pass the exact `id` returned by the plugin, not a URI, display name or result object. Release removes the plugin-owned native copy or revokes its browser Blob URL. It never deletes the selected source file. An already-released or evicted valid ID succeeds; malformed IDs reject. Accessing the URI after release is unsupported.

```js
await chooser.releaseFile(file.id);
// Callback alternative:
chooser.releaseFile(file.id, () => console.log('Released'), console.error);
```

Native data/metadata results have no managed ID. Browser results from those methods do, so shared code can use `if (file.id) await chooser.releaseFile(file.id)`.

## Cancellation and errors

Canceling calls success with `undefined` and resolves the Promise. Read, copy, presentation and argument failures reject. Errors may be strings or Error objects; treat caught values as `unknown`, and use `String(error)` for a display message. Message prefixes are diagnostic details, not a stable error-code API.

A concurrent request rejects with `BUSY`. Disable picker controls until the request settles. Reset or navigation can invalidate callbacks; a destroyed JavaScript context cannot receive an old Promise result. There is no public programmatic-cancel method. See [lifecycle and troubleshooting](FILE-HANDLING.md#lifecycle-and-troubleshooting).

## TypeScript

The [bundled declarations](../index.d.ts) define every overload and result type. To type a Cordova application using the injected global, include the package in TypeScript's resolution and add a declaration file:

```ts
// chooser-global.d.ts
import 'cordova-plugin-chooser';
```

If your application's TypeScript files are modules, also set `compilerOptions.allowUmdGlobalAccess` to `true` in its `tsconfig.json` to use this injected global from those modules.

For module-based code that needs only types:

```ts
import type Chooser = require('cordova-plugin-chooser');

function describe(file: Chooser.FileMetadata): string {
  return `${file.name}: ${file.size ?? 'unknown'} bytes`;
}
```

If your bundler already resolves Cordova modules, `import chooser = require('cordova-plugin-chooser')` imports the bridge. Ensure `cordova/exec` resolves through Cordova; an ordinary Node.js import is unsupported. Always account for `undefined` cancellation and nullable metadata size.
