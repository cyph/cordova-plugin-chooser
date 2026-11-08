# API reference

Cordova exposes `chooser` after `deviceready`. The methods below describe RC2; use the [migration guide](MIGRATION.md) for earlier call forms. Picker methods return Promises and accept options objects. Open browser pickers directly from a user interaction.

## Methods

| Method | Successful result |
| --- | --- |
| `getFile(options)` | `ManagedFile` |
| `getFiles(options)` | Nonempty readonly array of `ManagedFile` |
| `withFile(options, consume)` | Awaited result of `consume(file)`, after cleanup |
| `withFiles(options, consume)` | Awaited result of `consume(files)`, after cleanup |
| `getFileMetadata(options?)` | `FileMetadata` |
| `getFilesMetadata(options?)` | Nonempty readonly array of `FileMetadata` |
| `getFileData(options)` | `FileData` in the requested format |
| `getFilesData(options)` | Nonempty readonly array of `FileData` in the requested format |
| `restoreFile(reference, options?)` | Managed handle for a saved reference |
| `releaseFile(id)` | `void` |
| `releaseFiles(ids)` | `void` |

Cancellation rejects with `CancellationError`, including cancellation through an `AbortSignal`. A successful picker never returns `undefined` or an empty array. A scoped consumer may return any value, including `undefined`.

Only one picker request can be active at a time. A second picker can reject with `BUSY`; reading an existing managed file does not open another picker. Native results preserve the provider's returned order and remove repeated URI selections. The provider's order need not match the order in which items were tapped.

## Selection options

All pickers accept an optional `signal`. The default source is documents:

```ts
interface DocumentSourceOptions {
  source?: 'documents';
  accept?: string | readonly string[];
  preferLocal?: boolean;
}
interface PhotoSourceOptions {
  source: 'photos';
  mediaTypes?: readonly ('image' | 'video')[];
}
```

For documents, `accept` takes MIME types such as `'application/pdf'`, wildcards such as `'image/*'`, a comma-separated list, or an array. Omit it or use `'*/*'` for unrestricted selection. Empty filters, filename extensions such as `'.pdf'`, and malformed types reject. Filters are normalized to lowercase and duplicates removed.

MIME filters guide the picker; they do not validate content. Providers determine which items are selectable. `preferLocal` defaults to `false` and is an Android provider hint, not a guarantee; it has no effect on iOS or the browser.

For photos, `mediaTypes` defaults to `['image', 'video']`. A supplied array must contain at least one of those values. Photo selection does not accept `accept` or `preferLocal`; document selection does not accept `mediaTypes`. See [platform behavior](PLATFORMS.md) for photo-picker availability and fallbacks.

Unknown options, callback arguments, and incompatible source options reject with `INVALID_ARGUMENT`.

## Byte and count limits

| Option | Required by | Meaning |
| --- | --- | --- |
| `maxFileSize` | Managed and direct-data pickers, including scoped helpers | Maximum bytes per selected file |
| `maxTotalSize` | Plural managed and direct-data pickers | Maximum bytes across the selection |
| `maxFiles` | Optional on all plural pickers | Maximum selected file count |
| `maxBytes` | Whole-file reading methods on a managed file | Maximum input bytes to materialize |

Byte limits must be positive safe integers or explicit `null` for unlimited. Omitted and zero byte limits reject. `maxFiles` accepts a positive safe integer, or omitted/`null` for no plugin-imposed count limit. System pickers can impose their own limits.

An empty file and a file exactly at a limit are accepted. Native byte limits count actual bytes; unreliable provider size metadata cannot bypass them. Limits reject an excessive selection as a whole, and the plugin cleans up partial results. They do not guarantee that oversized items will be hidden in the picker or bound a provider's download time. Whole-file read limits are separate from copy limits because memory and storage have different costs.

```js
const files = await chooser.getFiles({
  accept: ['image/*', 'application/pdf'],
  maxFiles: 4,
  maxFileSize: 10 * 1024 * 1024,
  maxTotalSize: 25 * 1024 * 1024
});
```

Release these managed files after use; [scoped helpers](#scoped-cleanup) handle that automatically when appropriate.

## Results and ownership

| Field | Meaning |
| --- | --- |
| `name` | Display name, with a fallback when unavailable; never a trusted filesystem path |
| `mediaType` | Reported or inferred MIME type; fallback `application/octet-stream` |
| `size` | Bytes; metadata can report `null`, while managed and direct-data results report actual size |
| `sourceUri` | Optional borrowed native source reference, which may identify an iOS temporary import; no persistence or continuing-access guarantee |
| `id` | Opaque ID on managed results only |
| `uri` | Private native cache URI or browser Blob URL on managed results only |

`FileMetadata` contains `name`, `mediaType`, `size`, and optional `sourceUri`. Metadata selection does not read or send complete file contents across the bridge, has no byte budgets, and retains no plugin-managed resource or release obligation. Photos metadata may be incomplete.

On iOS, document metadata selection requests an import: UIKit or the provider may copy or download the entire file, adding latency and disk use outside plugin byte budgets. iOS manages the temporary import’s lifetime. A borrowed `sourceUri` can refer to that import rather than the original provider location; it is not a managed URI and must not be passed to release methods, which accept managed IDs.

`ManagedFile` adds `id`, `uri`, and the reading and lifetime methods below. Native results are snapshots in app-private cache. Browser results retain the selected `File`. Releasing a managed file leaves the selected original untouched.

## Read a managed file

| Method | Result and options |
| --- | --- |
| `file.bytes({maxBytes, signal?})` | `Uint8Array<ArrayBuffer>` |
| `file.arrayBuffer({maxBytes, signal?})` | `ArrayBuffer` |
| `file.blob({maxBytes, signal?})` | `Blob` with the file's MIME type |
| `file.text({maxBytes, encoding?, fatal?, signal?})` | Decoded string |
| `file.dataURI({maxBytes, signal?})` | Complete base64 data URI with canonical padding |
| `file.getData({format, maxBytes, encoding?, fatal?, signal?})` | Metadata and the requested data representation; text options only for `format: 'text'` |
| `file.readRange({offset?, length, signal?})` | Byte array for a range |
| `file.stream({offset?, length?, signal?}?)` | `ReadableStream<Uint8Array<ArrayBuffer>>` |
| `file.textStream({offset?, length?, encoding?, fatal?, signal?}?)` | `ReadableStream<string>` |

Offsets and lengths are byte counts, must be nonnegative safe integers, and cannot overflow safe integer arithmetic when added. Offset defaults to zero. `readRange` requires a length; streams default to the remaining file. Zero length is valid. Reads at EOF return fewer bytes than requested, including an empty array beyond EOF. A text range can split an encoded character; choose ranges accordingly.

Whole-file and range methods return Promises. Stream factories return streams immediately and can throw during option validation; later failures reject stream reads. Streaming honors backpressure and handles text characters split across chunks. The plugin bounds bridge transfers internally; callers need not divide a larger range into bridge-sized pieces.

Text defaults to UTF-8 and `fatal: true`. Malformed input rejects with `DECODE_FAILED`. Set `fatal: false` to replace malformed sequences. Encoding labels follow `TextDecoder`; unsupported labels reject. Canceling a stream reader stops that reader without releasing the managed file.

## Direct data and formats

`getFileData` and `getFilesData` read the selection and return complete data, with no retained managed resource. They require `format` and the selection byte budgets. `file.getData` uses the same formats on an existing managed file and requires `maxBytes` instead.

| `format` | Additional result fields |
| --- | --- |
| `'bytes'` | `data: Uint8Array<ArrayBuffer>` |
| `'blob'` | `blob: Blob` with the file's MIME type |
| `'arrayBuffer'` | `arrayBuffer: ArrayBuffer` |
| `'text'` | `text: string` |
| `'dataURI'` | `dataURI: string` |
| `'bytesAndDataURI'` | Both `data` and `dataURI`, from one content read |

Each result also includes `format`, metadata, and actual `size`. For text format, pass `encoding` and `fatal` as top-level options; binary formats reject them. The `decoding` option is not accepted. Unlike the raw values returned by `file.blob()` and `file.arrayBuffer()`, `file.getData()` returns this envelope. Direct-data results have no `id`, `uri`, or `release` method; values already returned to JavaScript remain usable after the plugin closes its readers.

```js
const file = await chooser.getFileData({
  accept: 'text/csv',
  maxFileSize: 1024 * 1024,
  format: 'text',
  encoding: 'utf-8',
  fatal: true
});
console.log(file.name, file.text);
```

Direct data has no retained managed file after successful completion, but it can require temporary storage. For iOS Photos, Chooser copies the selected representation into app-private cache before the provider's temporary URL expires, then reads that staged copy into the requested format. This uses temporary storage proportional to the selected representations, adds a copy step, and can coexist with the provider's own temporary files. Chooser removes its staged copies automatically; callers do not release direct-data results. Cleanup failures are reported through `CleanupError`. The complete result still occupies memory; use managed streams for large inputs.

## Scoped cleanup

`withFile(options, consume)` and `withFiles(options, consume)` select managed files, await the consumer, release the resources, and return the consumer's result. The consumer can be synchronous or asynchronous. It must await every operation that uses the resources, including failure paths and parallel work.

A returned handle, URI, or stream is expired after scoped cleanup. Return parsed data, a completed upload's result, or another value independent of the managed resource. Use `getFile`/`getFiles` when the lifetime extends beyond one function.

If cleanup succeeds, the helper preserves the consumer's result or throws its original exception unchanged. If cleanup fails, it throws `CleanupError` with:

```ts
type OperationOutcome<T> =
  | {status: 'fulfilled'; value: T}
  | {status: 'rejected'; reason: unknown};

// error.outcome: OperationOutcome<T>
// error.failures: readonly {id: string; error: ChooserError}[]
```

A fulfilled outcome means the consumer completed successfully even though resource cleanup failed. Retry cleanup using the failed IDs; do not automatically repeat the consumer's upload or other side effect. The same error preserves a cancellation outcome if cleanup also fails. Direct-data methods likewise preserve a completed result when closing their temporary readers fails.

## Release and restoration

`file.release()`, `releaseFile(file.id)`, and `releaseFiles(ids)` share ownership by ID. Restored aliases do not own independent copies. Starting release prevents new reads through every alias, stops unfinished plugin streams with `FILE_RELEASED`, waits for started one-shot reads and native I/O, then releases the resource. Release does not wait for an unread stream to be consumed.

External URI readers are outside this coordination: wait for them before releasing. Deletion failures are retryable, but old handles stay closed to new reads. Releasing an already absent resource succeeds. Batch release requires a dense array of valid IDs: it rejects missing entries and validates every ID before changing anything. It deduplicates IDs, attempts all releases, and reports per-ID failures on `RELEASE_FAILED`.

Save a serializable reference with `file.toJSON()` or `JSON.stringify(file)`. `restoreFile(reference, {signal}?)` validates it and asks the platform for authoritative resource status. It resolves native files by managed ID, not a supplied URI or filename. Restoration does not make cache storage durable. Native references can survive app restart only while the copy remains; browser references require the original page's live registry. Surviving native RC1 managed IDs remain releasable.

## Cancellation and errors

Catch `chooser.CancellationError` for expected picker dismissal or a canceled operation. Its stable `code` is `CANCELLED`, and `reason` is `'picker'` or `'signal'`. When an operation is canceled by its supplied `AbortSignal`, the cancellation's `cause` preserves that signal's `reason`. A rejected `CleanupError.outcome` preserves the failure when cleanup also fails, including through nested cleanup errors. A custom or native cancellation without an associated aborted signal need not have that cause.

Pass an `AbortSignal` to the operation you want to cancel. An already aborted signal prevents selection; aborting during work requests cancellation and cleanup. Settlement may wait for provider I/O. A selection signal does not attach itself to every later read or to the scoped consumer: pass it to reads explicitly. Cleanup waits for the consumer to settle before releasing its files.

`ChooserError.code` distinguishes invalid arguments, busy or unsupported operations, picker/access failures, size/count limits, read/decode/copy/cache failures, unavailable/released resources, release/cleanup failures, and memory exhaustion. See [the declarations](../index.d.ts) for the complete `ErrorCode` union. Messages are explanatory text, not an API to parse. Application exceptions from scoped consumers can be any value.

## TypeScript

The bundled declarations require **TypeScript 5.7 or later** and DOM types for signals, blobs, and streams. Byte results use `Uint8Array<ArrayBuffer>`, so they can be passed to DOM APIs accepting ordinary ArrayBuffer-backed bytes.

To include the Cordova global without emitting a runtime import:

```ts
// chooser-global.d.ts
import 'cordova-plugin-chooser';
```

For global access from module source files, enable `allowUmdGlobalAccess` in `tsconfig.json`. Import types without a runtime import when needed:

```ts
import type Chooser = require('cordova-plugin-chooser');

function describe(file: Chooser.FileMetadata): string {
  return `${file.name}: ${file.size === null ? 'unknown size' : file.size + ' bytes'}`;
}
```

Ensure TypeScript can resolve the package, and wait for `deviceready` before calling the runtime global. A runtime package import still needs Cordova's `cordova/exec`; it does not create a standalone picker.
