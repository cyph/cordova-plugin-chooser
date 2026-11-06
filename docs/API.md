# API reference

Cordova exposes `chooser` as a global after `deviceready`. Open a browser picker directly from a user interaction. A request owns the picker until selection and any reading or copying finish; concurrent requests reject as busy. Reset or interruption can affect that ownership; see [platform lifecycle behavior](PLATFORMS.md#lifecycle).

## Methods

| Method | First argument | Promise result |
| --- | --- | --- |
| `getFile()` | Optional MIME filter | `FileData \| undefined` |
| `getFileMetadata()` | Optional MIME filter | `FileMetadata \| undefined` |
| `getFiles()` | Optional MIME filter | `FileData[] \| undefined` |
| `getFilesMetadata()` | Optional MIME filter | `FileMetadata[] \| undefined` |
| `getFileUri()` | Optional MIME filter or `CopyOptions` | `FileReference \| undefined` |
| `getFilesUri()` | Optional MIME filter or `CopyOptions` | `FileReference[] \| undefined` |
| `releaseFile(id)` | Managed ID | `void` |

Data methods return all bytes and a base64 data URI. They read the entire file into memory and have no configurable size limits. Metadata methods do not read the whole file in plugin code, although the OS or provider may import or download it. A later picker call is a new selection, not a continuation of the metadata request.

URI methods produce references without sending the file contents over the bridge. Android and iOS stream private cache copies; the browser creates Blob URLs for selected files. See [file handling](FILE-HANDLING.md) for consumption and cleanup.

Cancellation resolves to `undefined`. A successful plural call returns a nonempty array, even for one file. Native platforms remove duplicate selected URIs and preserve the provider's returned order, which need not be the order of user selection.

## Promises and callbacks

Each picker returns a Promise and accepts optional success and failure callbacks. These examples are alternative forms:

```js
chooser.getFile();
chooser.getFile('image/*');
chooser.getFile(onSuccess, onError);
chooser.getFile('image/*', onSuccess, onError);
chooser.getFileUri({accept: 'image/*', maxFileSize: 10485760}, onSuccess, onError);
```

The callback-first form also applies to the other pickers. Success receives the same result as the Promise, including `undefined` on cancellation. Failure receives the rejection reason. The returned Promise remains available when callbacks are supplied; handle each result once.

```ts
type Success<T> = (result: T | undefined) => void;
type Failure = (error: unknown) => void;
```

Callback exceptions or rejected callback Promises are reported asynchronously and do not change the picker Promise's result. Handle errors inside asynchronous callbacks. `releaseFile(id, success?, failure?)` likewise returns a Promise and accepts callbacks, with no success value.

## Result types

These interfaces match the [bundled declarations](../index.d.ts):

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
| `name` | Display name supplied or derived by the platform. Treat it as text, not a trusted path. |
| `mediaType` | Reported or derived MIME type, with `application/octet-stream` as fallback. It does not validate contents. |
| `uri` | Native source/import URI for data or metadata, private `file:` URI for a native copy, or Blob URL in a browser. |
| `size` | Bytes; native metadata may report `null` when the size is unavailable. Native data and copies count bytes read, and browser results use `File.size`. `FileData` retains the nullable declared type. |
| `id` | Opaque managed ID. Present on native URI results and all browser results. |
| `data` | File bytes as a `Uint8Array`, including an empty array for an empty file. |
| `dataURI` | `data:<mediaType>;base64,<contents>` for the complete file, with canonical base64 padding. |
| `sourceUri` | Original provider URI for a native copy; absent in browsers. |

URIs do not promise persistent access. See [reference lifetimes](FILE-HANDLING.md#reference-lifetimes).

## MIME filters

Pass a MIME type, wildcard, or comma-separated list, for example `'application/pdf'`, `'image/*'`, or `'image/*,application/pdf'`. Use MIME types rather than filename extensions such as `'.pdf'`. Omission or an empty string means `'*/*'`. The bridge lowercases the string and removes whitespace. A non-string filter, including `null`, rejects.

Filters are hints: providers determine what is selectable, and unknown iOS types can broaden the picker. Validate the selected contents in the consuming application.

## Copy options

Only `getFileUri()` and `getFilesUri()` accept an options object:

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
| `maxFiles` | `0` | Maximum number of files, after native URI deduplication |
| `maxTotalSize` | `0` | Maximum bytes across the selection |
| `localOnly` | `false` | Android: request local providers; ignored on iOS and browser |

Limits must be nonnegative JavaScript safe integers. Omitted or zero limits are unlimited, and a file or selection exactly at a limit is accepted. `accept` must be a string and `localOnly` a boolean. Unknown keys, invalid option values, non-string filters, and non-function callbacks reject with a `TypeError` before the picker opens. A supplied failure callback is notified of the rejection.

Native byte limits count streamed bytes, even when a provider's reported size is missing or wrong; browser limits use `File.size`. A selection over a limit rejects as a whole rather than returning a partial array. The plugin attempts to clean up resources created by a failed batch. See a [bounded selection example](FILE-HANDLING.md#consume-then-release).

On Android, the legacy single-file data and metadata methods request local providers. New multiple and URI methods allow remote providers by default. `localOnly: true` requests local providers for URI methods; the picker or provider decides how to honor that request.

## Release a reference

```ts
declare function releaseFile(id: string, success?: () => void, failure?: Failure): Promise<void>;
```

Pass the returned opaque ID after all consumers finish. Release removes the plugin-owned native cache copy or revokes its browser Blob URL, leaving the selected source alone. An already-absent managed resource normally succeeds; malformed IDs and filesystem failures can reject. Native data and metadata results have no ID, while every browser result does. Releasing a browser data result does not erase bytes or strings already held by JavaScript. See [cleanup guidance](FILE-HANDLING.md#consume-then-release).

## Cancellation and errors

Cancellation resolves successfully to `undefined`. Invalid arguments, presentation errors, read errors, and copy errors reject. Rejection reasons can be strings or `Error` objects; treat them as `unknown`. Prefixes such as `BUSY` or `FILE_TOO_LARGE` are diagnostic text, not stable typed error codes.

There is no public cancellation, timeout, or progress API. A timeout in application code does not cancel a native picker. Browser cancellation requires file-input `cancel` event support; without it a dismissed dialog can leave the request pending. See [known limitations](KNOWN-ISSUES.md) and [troubleshooting](TROUBLESHOOTING.md).

## TypeScript

The package's `types` field points to `index.d.ts`. Include the declarations in your TypeScript project to use the Cordova-injected global:

```ts
// chooser-global.d.ts
import 'cordova-plugin-chooser';
```

This declaration-file import emits no JavaScript. Ensure TypeScript can resolve the installed package. For global access from module source files, enable [`allowUmdGlobalAccess`](https://www.typescriptlang.org/tsconfig/allowUmdGlobalAccess.html):

```json
{
  "compilerOptions": { "allowUmdGlobalAccess": true }
}
```

Import types without a runtime import when needed:

```ts
import type Chooser = require('cordova-plugin-chooser');

function describe(file: Chooser.FileMetadata): string {
  return `${file.name}: ${file.size === null ? 'unknown size' : file.size + ' bytes'}`;
}
```

Wait for `deviceready` before calling the global. Runtime imports require Cordova's `cordova/exec` to resolve.
