# File handling

Start with a managed file when a consumer needs a URI, repeated reads, or incremental processing. Use `withFile` or `withFiles` when that work fits inside one function; use `getFile` or `getFiles` when the application needs to control the lifetime. Metadata and direct-data methods return values without a release obligation.

## Memory and storage

Native managed selection streams into app-private cache. It uses storage proportional to the selected contents without sending the whole file through the bridge. Browser managed selection retains a `File` and creates a Blob URL without reading all its bytes. Providers may also download, import, or convert a selection before the plugin can use it.

Direct-data selection from iOS Photos also stages each selected representation in app-private cache. The provider's temporary URL expires when its callback returns, so Chooser copies the contents before reading them into JavaScript. Allow temporary storage proportional to the selected representations and time for this additional copy; provider-owned temporary files may coexist with Chooser's copies. Chooser removes its staging files automatically before successful completion. The returned data needs no release; a cleanup failure is reported through `CleanupError`.

Choose `maxFileSize` and, for plural selection, `maxTotalSize` according to the application's storage allowance. These are required byte budgets; use explicit `null` only when unlimited input is acceptable. A provider's reported size is advisory. Native copy and direct-read limits count actual bytes.

Whole-file readers and direct-data methods still need memory for their complete result. Base64 adds roughly one third to the byte length, and encoded strings and buffers can coexist. `bytesAndDataURI` deliberately retains both representations. The `maxBytes` read budget limits input bytes, not total JavaScript heap consumption. A large `readRange({length})` also allocates the requested range.

For large inputs, consume `stream()` or `textStream()` incrementally and avoid accumulating every chunk. The plugin handles bounded bridge transfers and backpressure; the consuming parser or uploader must also avoid retaining the whole file.

## Consume, then release

This helper selects up to four files and processes them sequentially. The supplied consumer must settle only when all work using each file has finished:

```js
async function chooseAndConsume(consumeFile) {
  return chooser.withFiles({
    accept: ['image/*', 'application/pdf'],
    maxFiles: 4,
    maxFileSize: 10 * 1024 * 1024,
    maxTotalSize: 25 * 1024 * 1024
  }, async files => {
    const results = [];
    for (const file of files) results.push(await consumeFile(file));
    return results;
  });
}
```

Call it from a user interaction after `deviceready` and handle rejection. When processing in parallel, wait for all consumers to settle before leaving the scoped function. `Promise.all` alone can reject while other consumers are still using their files.

A cleanup failure preserves the completed operation's result or original failure:

```js
try {
  await chooseAndConsume(consumeFile);
} catch (error) {
  if (error instanceof chooser.CleanupError) {
    if (error.outcome.status === 'fulfilled') {
      console.log('Processing completed:', error.outcome.value);
    } else {
      console.error('Processing failed:', error.outcome.reason);
    }
    console.error('Cleanup needs attention:', error.failures);
    // Retain failed IDs if the app will retry releaseFiles later.
  } else if (!(error instanceof chooser.CancellationError)) {
    console.error('Selection or processing failed:', error);
  }
}
```

Retry failed cleanup separately from business operations such as uploads. Repeating the whole operation after a successful upload can create duplicates.

For longer-lived previews or background work in the current application session, use `getFile`, retain the handle, and call `file.release()` when every consumer finishes. Releasing any alias closes all handles for that ID. It stops unfinished plugin streams, waits for started one-shot reads and native I/O, and prevents new reads. An external URI consumer must finish before release; the plugin cannot observe its lifetime.

For example, use a managed URI and read multiple ranges inside a scoped helper:

```js
async function inspectAndUpload(uploadUri) {
  return chooser.withFile({maxFileSize: 10 * 1024 * 1024}, async file => {
    const header = await file.readRange({offset: 0, length: 16});
    const next = await file.readRange({offset: 16, length: 16});
    await uploadUri(file.uri, file.name, file.mediaType);
    return {header, next};
  });
}
```

The URI consumer must finish before release. The scoped helper reports both the operation outcome and cleanup failures through `CleanupError` when cleanup fails.

## Stream a file

`textStream` preserves multibyte characters across chunks. Chunk boundaries are not line or record boundaries; an incremental parser must carry partial records between calls.

```js
async function chooseTextAndProcess(acceptChunk) {
  return chooser.withFile({
    accept: 'text/*',
    maxFileSize: 100 * 1024 * 1024
  }, async file => {
    const reader = file.textStream().getReader();
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        await acceptChunk(value);
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    return file.name;
  });
}
```

Canceling this reader stops its stream without releasing the file; the scoped helper releases it after the function settles. Pass a `signal` to `textStream` to make reads abortable. Pass a signal to selection separately if selection should also be cancelable. UTF-8 decoding is strict by default; set the top-level `encoding` and `fatal` options on `textStream`, `text`, or a text-format data call as needed. Set `fatal: false` only when replacement characters are acceptable.

## Native consumers

Managed native `uri` values refer to private cache files. Pass them to a native reader, uploader, or storage integration that accepts local file URIs. Use Chooser's `bytes`, `text`, range, or stream methods for portable JavaScript reading. WebView `fetch(file.uri)` is not a portable native-file reader.

To keep a file, copy it into application-managed persistent storage before release. To share it with another app, use an integration that provides the necessary URI and access grant; a private cache URI alone does not grant another app access. Cache filenames are generated IDs, so pass the display name and MIME type separately where the consumer needs them.

`sourceUri` is a borrowed provider reference, not a managed copy. It may be absent or stop working when temporary access ends. The plugin does not provide persistent provider access or turn every provider URI into an original filesystem path.

## Browser consumers

A live managed Blob URL can be used by supported preview elements or read with browser `fetch`. Keep the managed file until the preview is no longer needed or the read finishes. The reading methods on the handle work across all supported platforms and avoid URI-scheme differences.

Metadata and direct-data results do not retain Blob URLs and need no release. Releasing a managed URL does not erase a byte array, string, or Blob already returned to JavaScript.

### Content Security Policy

Allow `blob:` only in directives used by the app's consumers: for example, `img-src` for images, `media-src` for audio/video, and `connect-src` when fetching a Blob URL. This fragment allows same-origin and Blob URL image previews and connections:

```text
connect-src 'self' blob:;
img-src 'self' blob:;
```

Merge the needed sources into the existing policy and retain other trusted origins. This is a fragment, not a complete application policy.

## Reference lifetimes

| Result | Lifetime and cleanup |
| --- | --- |
| Metadata | Plain values; optional `sourceUri` is borrowed |
| Direct data | Plain values and complete data; plugin readers are closed and any plugin staging files are removed before successful delivery |
| Native managed file | Private cache snapshot; release after use; eviction remains possible |
| Browser managed file | Current page's retained `File` and Blob URL; release after use or navigation |

Native snapshots do not follow later source changes. Saving `file.toJSON()` saves a reference, not the contents. `restoreFile(savedReference)` checks whether the managed resource still exists. Native cache copies can survive a restart but can also be evicted; browser references cannot be restored after their page registry is lost. Navigation through `pagehide`, including entry into the back/forward cache, revokes browser resources.

`releaseFiles` requires a dense array of valid IDs and validates the entire array before releasing anything. IDs are opaque. Pass them back unchanged; do not derive them from filenames or URIs. Surviving native RC1 cache IDs remain releasable with `releaseFile`. Release is idempotent for absent resources and retryable after deletion failures. A failed release leaves handles closed to new reads.

## Failed and interrupted work

A failed selection does not return a partial array. The plugin cleans up resources created for that request; a cleanup failure is reported rather than disguised as ordinary cancellation. Earlier successful selections remain independently owned.

Native provider work may finish after a reset or cancellation request. The plugin waits for actual I/O before deleting resources in use. A WebView reset cannot preserve its JavaScript Promises or turn a copy or upload into a durable background job. See [lifecycle behavior](PLATFORMS.md#lifecycle).

## Names and content types

Display names and MIME types describe a selection; they do not prove its contents. Render names with text APIs, use application-controlled paths for storage, and validate data in the component that consumes it. Picker filters cannot substitute for format validation.

## CSV, JSON, and provider filters

For a small CSV, request text and give it to a CSV parser:

```js
async function chooseSmallCsv(parseCsv) {
  const file = await chooser.getFileData({
    accept: 'text/csv',
    maxFileSize: 1024 * 1024,
    format: 'text'
  });
  return parseCsv(file.text);
}
```

The parser must handle quoting, delimiters, and headers. `JSON.parse` parses JSON, not CSV; serializing a byte array does not interpret rows. For large documents, use a managed text stream with an incremental parser.

If a CSV or JSON document is disabled in a provider, try `accept: '*/*'` to distinguish filtering from availability. Providers can classify files differently. Inspect the selected metadata and validate contents before use.
