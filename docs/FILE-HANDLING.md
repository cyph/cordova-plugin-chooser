# File handling

Call the picker directly from the user's click. The examples use Capacitor's `Chooser` import. In Cordova, use the `chooser` global after `deviceready`. See the [Cordova quick start](../README.md#pick-a-text-file-in-cordova) and [API reference](API.md).

## Choose an ownership model

Use `getFileMetadata` when a name, type, and reported size are enough. Use `getFileData` for a complete small result such as text or bytes. Both return values without a managed resource to release.

Use `withFile` when work on the file fits within one callback. The helper releases its managed copy after that callback settles. Use `getFile` when the app needs the URI or handle for a longer interval, and release it explicitly. Plural counterparts follow the same pattern.

A native managed file is a snapshot in private cache. A browser handle retains a `File` and a Blob URL. Both are temporary. If the app needs a permanent copy, transfer it into app-managed persistent storage before release. `sourceUri` is a borrowed provider reference and may stop working even sooner.

## Read a small file

The example below reads up to 1 MiB of text and puts it on the page. Provide an element with `id="file-result"` and call the function from a button.

```ts
import { Chooser } from 'cordova-plugin-chooser/capacitor';

async function readTextFile(): Promise<void> {
  try {
    const file = await Chooser.getFileData({
      accept: 'text/plain',
      maxFileSize: 1024 * 1024,
      format: 'text'
    });
    document.querySelector<HTMLElement>('#file-result')!.textContent =
      `${file.name}\n${file.text}`;
  } catch (error) {
    if (!(error instanceof Chooser.CancellationError)) {
      console.error('Could not read the file', error);
    }
  }
}
```

Direct data is convenient because the plugin closes its readers before returning. It still materializes the complete result in memory. For JSON, apply `JSON.parse` to `file.text` and handle invalid input. For CSV, use a CSV parser rather than treating JSON parsing or byte serialization as CSV parsing. MIME filters are hints, so validate the contents your application consumes.

## Memory and storage

Set `maxFileSize` to the largest file the app can accept. Multiple-file managed or data calls also require `maxTotalSize`. Use explicit `null` only when an unlimited input is acceptable. Native copy limits count actual bytes rather than trusting provider size metadata. Provider downloads or conversions can occur outside those limits.

Whole-file managed readers require their own `maxBytes`. A file permitted in cache may still be too large to materialize in memory. Text and base64 can require more heap than the input byte count. `bytesAndDataURI` retains both representations, and a large range read allocates its requested bytes. For large inputs, process a stream incrementally without collecting all chunks in another array.

Native managed selection consumes cache space. iOS Photos direct-data selection also stages a temporary private copy before reading, because the provider's representation expires. That staging may coexist with provider files and takes space proportional to the selection. Plugin cleanup removes the staging copy, and cleanup errors are reported to the caller.

## Consume, then release

For a short operation, `withFile` keeps the resource alive until the callback settles. Here the upload must finish inside the callback.

```js
async function chooseAndUpload(uploadUri) {
  return Chooser.withFile({maxFileSize: 10 * 1024 * 1024}, async file => {
    const header = await file.readRange({offset: 0, length: 16});
    const receipt = await uploadUri(file.uri, file.name, file.mediaType);
    return {header, receipt};
  });
}
```

The returned receipt is independent of the released file. Do not return the handle, URI, or stream for later use. If several consumers run concurrently, wait for all of them to settle before leaving the callback. An early rejection from `Promise.all` alone can leave another consumer running after cleanup.

The helper throws `CleanupError` if release fails. Its `outcome` tells you whether the callback succeeded or failed, and `failures` identifies resources whose release failed. A successful upload is still successful when later cleanup fails. Retry cleanup using the failed IDs instead of automatically repeating the upload. See [scoped cleanup](API.md#scoped-cleanup).

For a longer-lived preview or background operation, hold the result of `getFile` and call `file.release()` when all consumers have finished. Releasing an ID closes every alias, stops unfinished plugin streams, and waits for started one-shot reads. The plugin cannot tell when another native component has finished using a URI, so the app must coordinate that lifetime.

## Stream a file

The following callback consumes each text chunk before requesting the next. The caller supplies an incremental processor and handles selection errors.

```js
async function processText(acceptChunk) {
  return Chooser.withFile({
    accept: 'text/plain',
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

A chunk is not necessarily a line or record. Keep partial records in the parser. Text streams preserve multibyte characters across chunk boundaries. UTF-8 decoding is strict by default. Pass `encoding` or `fatal: false` to the read when your input requires it. A signal applies to the operation receiving it, so supply one separately to selection and reading if both should be abortable.

## Native consumers

A managed native `uri` points to app-private cache. A native uploader or reader must support that URI, or the app must provide a suitable conversion. WebView `fetch(file.uri)` is not a portable native file reader. Pass the display name and media type separately when the consumer needs them because cache names are generated IDs. Sharing with another app requires an integration that grants access. A private URI by itself does not provide that grant.

## Browser consumers

A live managed Blob URL can be used for previews or browser `fetch`. Wait for the preview or fetch to finish before release. Chooser's handle methods provide portable reads across platforms. Navigation through `pagehide`, including entry into the back/forward cache, revokes browser resources.

### Content Security Policy

The app's policy must permit `blob:` in each directive that needs it. For example, image previews and Blob URL fetches may need these sources merged into the existing policy.

```text
img-src 'self' blob:;
connect-src 'self' blob:;
```

Add `media-src blob:` for media previews when needed. Preserve other sources the application requires.

## Reference lifetimes

A managed file's `toJSON()` produces a reference that can be passed to `restoreFile`, not a durable copy of its bytes. Native cache can survive restart but can also be evicted. Browser restoration requires the original page registry and does not survive navigation. Release accepts the opaque ID, not `sourceUri`. Batch release validates all IDs before changing anything and reports individual failures. An absent resource is safe to release again.

## Failed and interrupted work

A failed batch does not return partial results. If cleanup also fails, inspect the reported failures. Earlier successful selections remain independently owned. Reset or cancellation can occur while native provider work is still finishing, and cleanup waits for I/O that is actually in progress. A destroyed WebView cannot retain its JavaScript Promise or resume an upload automatically. See [Android lifecycle](PLATFORMS.md#lifecycle).

## Names and content types

Use names as display text, not as trusted paths. A provider's media type is a description, not proof of format. Save files under application-controlled names and validate contents at the point of use.

## CSV, JSON, and provider filters

If a provider disables a document, try an unrestricted filter to determine whether MIME classification is the cause. The app still needs to validate the chosen content. A large CSV needs a streaming parser that handles quoted fields and records split across chunks.
