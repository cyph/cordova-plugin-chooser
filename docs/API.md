# API reference

Use the injected `chooser` global after `deviceready`. In browsers, invoke a picker directly from a user interaction. Only one picker request can be active at a time, including the work needed to read or copy its selection.

The [bundled TypeScript declarations](../index.d.ts) define all public overloads. [File handling](FILE-HANDLING.md) explains how to consume results and release resources. Rejection of invalid filters, callbacks, and unknown option keys is an [unreleased change](../CHANGELOG.md#unreleased); valid calls retain the RC1 API.

## Methods

| Method | Optional first argument | Promise result |
| --- | --- | --- |
| `getFile()` | MIME filter | `FileData \| undefined` |
| `getFileMetadata()` | MIME filter | `FileMetadata \| undefined` |
| `getFiles()` | MIME filter | `FileData[] \| undefined` |
| `getFilesMetadata()` | MIME filter | `FileMetadata[] \| undefined` |
| `getFileUri()` | MIME filter or `CopyOptions` | `FileReference \| undefined` |
| `getFilesUri()` | MIME filter or `CopyOptions` | `FileReference[] \| undefined` |
| `releaseFile(id)` | Required managed ID | `void` |

Data methods return complete contents as a `Uint8Array` and base64 data URI. They have no limits; use them for small files.

Metadata methods omit `data` and `dataURI` and do not read complete contents in plugin code. The OS or provider may still import or download the document before returning it. A metadata request followed by another picker request does not automatically select the same file.

URI methods return metadata and a managed reference without transferring contents through the bridge. Android and iOS stream a copy into private cache; the browser creates a Blob URL for the selected `File`.

Successful plural methods return a nonempty array. Cancellation returns `undefined`, never an empty array. Native platforms remove duplicate selected URIs while preserving the provider's returned order; that order need not match the order in which the user clicked items.

## Promises and callbacks

Every picker supports these alternative calling forms:

```js
chooser.getFile();
chooser.getFile('image/*');
chooser.getFile(onSuccess, onError);
chooser.getFile('image/*', onSuccess, onError);
```

These are alternatives, not concurrent calls. Substitute any picker method; URI methods also accept an options object in the first position. The callback types are:

```ts
type Success<T> = (result: T | undefined) => void;
type Failure = (error: unknown) => void;
```

Callbacks are optional and do not replace the returned Promise. Success receives the same value as the Promise, including `undefined` on cancellation; failure receives the rejection reason. Process the result in one place to avoid duplicate work.

If an application callback throws or returns a rejected Promise, its error is reported asynchronously without changing the picker Promise's outcome. Catch errors inside asynchronous callbacks. Promise-based callers can use `try`/`catch`/`finally`, as in the [quick start](../README.md#quick-start).

For callback-style metadata inspection, invoke this after `deviceready` from a selection control:

```js
chooser.getFileMetadata('application/pdf', async file => {
  if (file === undefined) return;
  try {
    document.getElementById('selection').textContent = file.name;
  } catch (error) {
    console.error('Could not display the selection.');
  } finally {
    if (file.id) {
      try {
        await chooser.releaseFile(file.id);
      } catch (error) {
        console.error('Could not release the file reference.');
      }
    }
  }
}, () => console.error('Could not select a file.'));
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
| `name` | Display name supplied or derived by the platform. Render as text; do not treat it as a trusted destination path. |
| `mediaType` | Provider-reported or filename-derived MIME type, falling back to `application/octet-stream`. It does not validate contents. |
| `uri` | Source/import URI for native data and metadata results; private `file:` URI for native copies; `blob:` URL for every browser result. |
| `size` | Bytes. Native metadata uses a reported size or `null`; native data and copies use actual bytes read. Browser results use `File.size`. `FileData` inherits the nullable metadata declaration. |
| `id` | Opaque identifier for `releaseFile()`. Present on native copy results and every browser result. |
| `data` | Exact bytes as a `Uint8Array`, supplied only by data methods. Empty files produce an empty array. |
| `dataURI` | `data:<mediaType>;base64,<contents>` with canonical padding, supplied only by data methods. |
| `sourceUri` | Original native provider URI for a managed copy. Absent in browsers; it is not a persistent access grant. |

See [reference lifetimes](FILE-HANDLING.md#reference-lifetimes) before saving or passing a URI to another component.

## MIME filters

Use a MIME type, wildcard, or comma-separated list: `'application/pdf'`, `'image/*'`, or `'image/*,application/pdf'`. Omission or an empty string selects `'*/*'`. The bridge lowercases the filter and removes whitespace. Filename extensions such as `'.pdf'` are not the portable native filter contract.

Providers decide what matches. Unknown iOS types can broaden the picker to general items. Validate file contents independently of the filter, display name, and reported MIME type.

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
| `maxFiles` | `0` | Maximum selected files, after native URI deduplication |
| `maxTotalSize` | `0` | Maximum bytes across the selection |
| `localOnly` | `false` | Android only: ask the picker to exclude remote providers; ignored elsewhere |

Limits must be nonnegative JavaScript safe integers. Zero or omission means unlimited; a value exactly at a limit succeeds. `accept` must be a string and `localOnly` a boolean when supplied. Invalid arguments and unknown option names reject with a `TypeError` before the picker opens. Use the exact keys above, including `accept` rather than a wrapper's `mimeTypes`.

Native byte limits count bytes while streaming, even when provider sizes are absent or incorrect. Browser limits use `File.size`. Count limits reject an oversized selection rather than truncate it. Single-file methods still return at most one file. A failed batch rejects as a whole and attempts to clean up its new resources; it never returns a partial array. Filesystem failures or unfinished provider work can delay cleanup.

Data and metadata methods accept an omitted filter, a MIME string, or the callback-first form. Objects, `null`, and other non-string filters reject. Supplied callbacks must be functions. Invalid calls reject their Promise and invoke a supplied failure callback without opening a picker. See [bounded-copy usage](FILE-HANDLING.md#consume-then-release) for a complete example.

## Release a reference

```ts
declare function releaseFile(
  id: string,
  success?: () => void,
  failure?: (error: unknown) => void
): Promise<void>;
```

Pass the exact returned `id`, not a URI, name, path, or result object. Release deletes a plugin-managed native copy or revokes a browser Blob URL. It never deletes the selected source file. A valid ID whose resource is already absent normally succeeds; malformed IDs and filesystem access/deletion failures can reject.

Native data and metadata results have no ID. Browser results from those methods do, so shared cleanup can check `if (file.id)`. Releasing a data result's Blob URL does not erase the bytes or data URI already held by JavaScript. See [cleanup guidance](FILE-HANDLING.md#consume-then-release).

## Cancellation and errors

Picker cancellation resolves successfully to `undefined`. Argument, presentation, read, and copy failures reject. Error values may be strings or `Error` objects; treat them as `unknown`. Show an appropriate application message and redact private filenames, URIs, and contents before sharing detailed diagnostics.

Prefixes such as `BUSY` or `FILE_TOO_LARGE` are diagnostic text, not a typed error-code interface. Avoid depending on complete message strings. There is no public programmatic-cancel method, timeout option, or progress callback. Lifecycle interruptions are described in [Platforms](PLATFORMS.md).

## TypeScript

The package's `types` field points to `index.d.ts`. To make the injected global visible, include this declaration file in your application's TypeScript project:

```ts
// chooser-global.d.ts
import 'cordova-plugin-chooser';
```

The import in a `.d.ts` file emits no JavaScript. Ensure TypeScript can resolve the installed package. If application source files are modules, enable [`allowUmdGlobalAccess`](https://www.typescriptlang.org/tsconfig/allowUmdGlobalAccess.html):

```json
{
  "compilerOptions": {
    "allowUmdGlobalAccess": true
  }
}
```

For types without a runtime import:

```ts
import type Chooser = require('cordova-plugin-chooser');

function describe(file: Chooser.FileMetadata): string {
  return `${file.name}: ${file.size === null ? 'unknown size' : file.size + ' bytes'}`;
}
```

Runtime imports require `cordova/exec` to resolve through Cordova. Prefer the injected global, wait for `deviceready`, and handle cancellation and nullable metadata.
