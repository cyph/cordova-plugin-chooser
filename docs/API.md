# API reference

This reference describes 2.0.0-rc.2. In Capacitor, import `Chooser` from `cordova-plugin-chooser/capacitor`. In Cordova, use the `chooser` global after `deviceready`. Every picker returns a Promise and takes an options object. Only one picker can run at a time. Concurrent selection can fail with `BUSY`, although reading a file already selected does not open another picker.

## Methods

| Method | Resolves to |
| --- | --- |
| `getFile(options)` | One managed file |
| `getFiles(options)` | A nonempty array of managed files |
| `withFile(options, consume)` | The consumer's result after release |
| `withFiles(options, consume)` | The consumer's result after release |
| `getFileMetadata(options?)` | One metadata object |
| `getFilesMetadata(options?)` | A nonempty array of metadata objects |
| `getFileData(options)` | One complete data result |
| `getFilesData(options)` | A nonempty array of complete data results |
| `restoreFile(reference, options?)` | A managed handle for a validated saved reference |
| `releaseFile(id)` | `void` |
| `releaseFiles(ids)` | `void` |

Dismissal rejects with `CancellationError`, so a successful picker does not return `undefined` or an empty array. A scoped consumer can itself return `undefined`. Native multiple selections remove repeated URIs and preserve the provider's returned order, which need not be tap order.

<a id="copy-options"></a>
<a id="mime-filters"></a>

## Selection options

For documents, omit `source` or set it to `'documents'`. `accept` accepts a MIME type, a comma-separated string, or an array of MIME types. Wildcards such as `'image/*'` and `'*/*'` are supported. Omission means unrestricted selection. Empty strings, extensions such as `'.pdf'`, and malformed MIME types reject. The plugin normalizes case and removes duplicates. Filters influence the picker but do not verify file contents.

On Android, `preferLocal: true` asks the provider for local items. It defaults to `false`, and the provider decides whether to honor the hint. It has no effect on iOS or Browser.

For a library picker, use `source: 'photos'` and optionally `mediaTypes: ['image']`, `['video']`, or both. Both are selected by default. An explicitly supplied list must be nonempty. `accept` and `preferLocal` are document options and cannot be combined with `source: 'photos'`. Conversely, `mediaTypes` is not a document option. See [platform behavior](PLATFORMS.md) for the picker and fallback used on each platform.

All selection methods accept `signal?: AbortSignal`. Unknown options, incompatible source options, and extra callback arguments reject with `INVALID_ARGUMENT`.

## Byte and count limits

| Option | Where required | Purpose |
| --- | --- | --- |
| `maxFileSize` | Managed and direct-data selection, including scoped helpers | Limit each selected file in bytes |
| `maxTotalSize` | Plural managed and direct-data selection | Limit the whole selection in bytes |
| `maxBytes` | Whole-file reads on a managed handle | Limit input bytes materialized by that read |
| `maxFiles` | Optional on plural selection | Limit selected count |

Byte limits are positive safe integers, or explicit `null` when unlimited input is acceptable. Omitted or zero required byte limits are invalid. `maxFiles` takes a positive safe integer or `null`, and can be omitted. Metadata methods accept no byte budgets. Single-file methods do not accept plural options.

Empty files and files exactly at the limit are allowed. Native operations count actual bytes, even if a provider reports the wrong size. An excessive batch fails as a whole and partial plugin resources are cleaned up. A limit does not necessarily hide oversized files from the picker or bound provider download time. The separate read budget matters because a disk copy and a JavaScript allocation have different costs.

<a id="result-types"></a>

## Results and ownership

All results provide `name`, `mediaType`, and `size`. The name is a display value rather than a trusted path. The media type is descriptive and falls back to `application/octet-stream`. Metadata size can be `null`. Managed and data results give actual byte counts. An optional `sourceUri` is a borrowed native reference, not a promise of continued access.

Metadata selection does not read or bridge complete contents in plugin code, and no managed ID needs release. A provider may nevertheless do substantial work. In particular, iOS document metadata asks UIKit to import the file, which can copy or download it in full outside plugin limits. iOS owns that temporary import, and `sourceUri` may refer to it. Photo metadata can also be incomplete.

A `ManagedFile` adds an opaque `id`, temporary `uri`, and methods for reading and release. Native managed files are private cache snapshots. Browser managed files retain the selected `File` and a Blob URL. Releasing them does not modify the original. A direct-data result contains the requested representation and needs no release.

## Read a managed file

| Method | Result |
| --- | --- |
| `file.bytes({maxBytes, signal?})` | `Uint8Array<ArrayBuffer>` |
| `file.arrayBuffer({maxBytes, signal?})` | `ArrayBuffer` |
| `file.blob({maxBytes, signal?})` | `Blob` with the file's media type |
| `file.text({maxBytes, encoding?, fatal?, signal?})` | String |
| `file.dataURI({maxBytes, signal?})` | Base64 data URI |
| `file.getData({format, maxBytes, ...})` | Metadata plus the selected data representation |
| `file.readRange({offset?, length, signal?})` | Bytes in the requested range |
| `file.stream({offset?, length?, signal?}?)` | `ReadableStream<Uint8Array>` with a default reader |
| `file.textStream({offset?, length?, encoding?, fatal?, signal?}?)` | String `ReadableStream` |

Offsets and lengths count bytes. They must be nonnegative safe integers whose sum does not overflow. Offset defaults to zero. A range requires `length`, whereas a stream defaults to the remaining bytes. Zero length is valid. At the end of a file a range can be shorter than requested, including empty beyond EOF. A text range can start or end within a character.

Whole-file and range operations return Promises. Stream factories return immediately and can throw for invalid options. Subsequent failures reject reader operations. Byte streaming honors backpressure. Text streaming also carries incomplete characters between chunks. The bridge uses bounded transfers, so a caller need not split a large range to match an internal chunk size. Canceling a reader does not release the file.

Text defaults to UTF-8 with `fatal: true`, so malformed input fails with `DECODE_FAILED`. Supply another `TextDecoder` encoding label where appropriate, or use `fatal: false` to replace malformed input. Unsupported labels reject.

## Direct data and formats

`getFileData` and `getFilesData` take a `format` and the selection limits. `file.getData` uses the same format names with a `maxBytes` read limit. Each returns metadata, actual size, a `format` discriminator, and the corresponding field.

| Format | Field |
| --- | --- |
| `'bytes'` | `data: Uint8Array<ArrayBuffer>` |
| `'text'` | `text: string` |
| `'dataURI'` | `dataURI: string` |
| `'bytesAndDataURI'` | `data` and `dataURI` from one content read |
| `'blob'` | `blob: Blob` |
| `'arrayBuffer'` | `arrayBuffer: ArrayBuffer` |

Text format accepts top-level `encoding` and `fatal`. Other formats reject those options. A nested `decoding` option is not accepted. `file.blob()` and `file.arrayBuffer()` return raw values, while `file.getData()` returns the envelope above. Returned data stays usable after plugin cleanup, but a whole-file result consumes memory.

For iOS Photos, direct-data selection stages a private copy before the provider's temporary representation expires. This requires temporary storage proportional to the selected contents, potentially alongside provider-owned copies. The plugin removes staging files before successful delivery. A cleanup failure is reported rather than requiring the caller to release a data result.

## Scoped cleanup

`withFile(options, consume)` and `withFiles(options, consume)` select managed files, await the consumer, release the files, and return the consumer's value. The consumer may be synchronous or asynchronous. Await every reader and external URI consumer before returning. A handle, URI, or stream returned from the callback is already released when the helper settles.

If both work and cleanup succeed, the value is returned. If work fails but cleanup succeeds, the original exception is rethrown. If cleanup fails, `CleanupError.outcome` records either `{status: 'fulfilled', value}` or `{status: 'rejected', reason}`, and `failures` contains failed IDs and errors. A fulfilled outcome means an upload or other side effect may already have succeeded. Retry the cleanup separately rather than repeating the side effect. Direct-data operations also report cleanup failures with their outcome.

<a id="release-a-reference"></a>

## Release and restoration

Call `file.release()`, `releaseFile(id)`, or `releaseFiles(ids)` after all consumers finish. Handles restored for the same ID are aliases, not copies. Releasing one closes all aliases to new reads, stops unfinished plugin streams, waits for started one-shot reads and native I/O, and removes the managed resource. External URI users are not tracked, so the app must wait for them. Failed deletion can be retried, though old handles remain closed. Releasing an absent resource succeeds.

`releaseFiles` takes a dense array of IDs. It validates the entire array before mutation, deduplicates IDs, attempts every unique release, and reports per-ID failures. Do not derive IDs from names or URIs.

Save the complete plain reference from `file.toJSON()` and pass it to `restoreFile(reference, {signal}?)`. Restoring a reference after release or eviction reports `FILE_UNAVAILABLE`. Browser references require the original page's live registry.

<a id="promises-and-callbacks"></a>

## Cancellation and errors

`CancellationError` has code `CANCELLED` and a `reason` of `'picker'` or `'signal'`. When a supplied signal causes cancellation, the error's `cause` preserves the signal's reason. If cleanup also fails, inspect the rejected `CleanupError.outcome` for the original error.

Pass a signal to each operation that should respond to it. Aborting selection does not automatically attach the signal to subsequent reads or the scoped consumer. An already aborted signal prevents selection. In-progress cancellation may wait for provider I/O and cleanup.

Other failures use `ChooserError.code`, including `INVALID_ARGUMENT`, `BUSY`, limit failures, access and read failures, and resource or cleanup failures. The complete union is in [index.d.ts](../index.d.ts). Branch on codes rather than diagnostic message text. A scoped consumer can also throw an arbitrary application error.

## TypeScript

Declarations require TypeScript 5.7 or newer and DOM types. The Capacitor import includes the declarations. In Cordova the global also has bundled types. For the injected global in a module, use a type query with no runtime import.

```ts
export {};
declare const chooser: typeof import('cordova-plugin-chooser');

async function describeSelection(): Promise<string> {
  const file = await chooser.getFileMetadata();
  return `${file.name}: ${file.size === null ? 'unknown size' : file.size + ' bytes'}`;
}
```

Wait for `deviceready` before calling the Cordova global. The Capacitor entry point works in web applications with the DOM and browser APIs listed in [platform requirements](PLATFORMS.md#browser).
