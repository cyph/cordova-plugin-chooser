# File handling

Choose metadata for inspection, data for small files processed in JavaScript, and URI methods for bounded copies or native consumers. Each picker call opens a new selection; metadata does not reserve a file for later calls.

## Memory and storage

`getFile()` and `getFiles()` load complete contents. Base64 increases the encoded length by roughly one third, and native buffers, bridge strings, decoded bytes, and data URIs may coexist. Multiple files compound that cost. The OS may terminate the application before it can report an allocation failure. There is no universal safe size for these methods, and inspecting the returned size is too late to prevent their allocation.

Use a URI method with explicit [copy limits](API.md#copy-options) when sizes are unknown. Native implementations stream into generated files in a dedicated app-private cache directory. Bounded buffering avoids loading the complete copy into memory, but its contents still consume disk space. Providers may need additional storage for downloads or imports. Limits constrain accepted file bytes and counts, not provider execution time or the provider's own resource use.

Browser URI methods create Blob URLs referencing the selected `File` objects without reading their contents with `FileReader`. A consumer that subsequently converts a reference into an array buffer, text, or base64 can still allocate the complete file.

## Consume, then release

Keep a managed reference until all readers, previews, uploads, and application copies have finished. Then release its ID. This helper bounds the selection and attempts every release even if another release fails:

```js
async function chooseAndConsume(consumeFiles) {
  const files = await chooser.getFilesUri({
    accept: 'image/*,application/pdf',
    maxFiles: 4,
    maxFileSize: 10 * 1024 * 1024,
    maxTotalSize: 25 * 1024 * 1024
  });
  if (files === undefined) return;

  try {
    return await consumeFiles(files);
  } finally {
    await Promise.all(files.map(async file => {
      try {
        await chooser.releaseFile(file.id);
      } catch (error) {
        console.error('Could not release a selected file.');
        // Keep file.id here if your application will retry cleanup.
      }
    }));
  }
}
```

Your application supplies `consumeFiles`. Invoke the helper directly from a selection control after `deviceready`, and handle its rejection. The limits above allow four files, at most 10 MiB each and 25 MiB in total. All consumption must finish before the supplied Promise settles, on both success and failure paths. Cleanup errors are handled separately so they do not replace a processing error.

For parallel consumers, a plain `Promise.all()` can reject while another consumer is still running. Wait for every consumer to settle before releasing references. Use `Promise.allSettled()` where available, or attach success and failure handlers to each consumer before awaiting `Promise.all()` of those non-rejecting outcomes. Applications supporting older WebViews should check runtime availability or provide a polyfill. Sequential processing is another straightforward option.

### Native consumers

Android and iOS URI methods return private `file:` URIs. Use a native reader, uploader, or storage integration that explicitly accepts local file URIs. Ordinary WebView `fetch(file.uri)` is not a portable native-file reader. Chooser supplies selection and temporary copies; uploading, sharing, and saving to permanent storage belong to the consuming application.

For cross-app access, use a sharing integration. Android commonly requires a `FileProvider` and a temporary grant; see [file-sharing guidance](https://developer.android.com/training/secure-file-sharing/share-file).

### Browser consumers

A live Blob URL can be assigned to a supported preview element or read using `fetch(file.uri)`. Keep the reference until the preview or read finishes. `response.blob()`, `response.arrayBuffer()`, and `response.text()` consume the complete response; use supported response-body streaming for incremental processing and keep application buffering bounded.

For metadata inspection, use the returned `name`, `mediaType`, and `size` directly. Fetching a Blob merely to obtain its size is unnecessary. Browser data and metadata results also own Blob URLs and require release when no longer needed, even if your application never uses their `uri` field.

### Content Security Policy

The application's Content Security Policy (CSP) must allow `blob:` for the consumer using the URL. Cordova's default application policy can block reads and previews even after selection succeeds. Add `blob:` to `connect-src` for `fetch()` reads, `img-src` for image previews, or `media-src` for audio/video previews, according to the application's needs.

For example, these directives allow same-origin connections and images plus Blob URL reads and image previews:

```text
connect-src 'self' blob:;
img-src 'self' blob:;
```

Merge the required sources into the application's existing directives, retaining any trusted origins it already needs. This fragment is not a complete policy. Keep the rest of the policy intact and grant `blob:` only to the relevant consumers; `'self'` alone is not a portable allowance for Blob URLs. See the [CSP specification](https://www.w3.org/TR/CSP3/#directive-connect-src).

## Reference lifetimes

| Result | URI lifetime | Cleanup |
| --- | --- | --- |
| Native data or metadata | Controlled by the OS/provider; continued access is not promised | No managed ID is returned |
| Native URI method | App-private cache, until release or cache removal | Call `releaseFile(id)` |
| Any browser result | Current page, until release or `pagehide` | Call `releaseFile(id)` |

Native copies are snapshots of the bytes read. They do not track later edits to the original. Copies may survive app restarts, but cache is not durable storage and can be evicted. Copy important contents into application-managed persistent storage. Retain the display name and MIME type separately: generated native cache names have no meaningful extension.

IDs are opaque. Pass them back unchanged; do not derive IDs from paths, construct cache paths, or edit the plugin's cache journals. A repeated release normally succeeds for an already-absent resource, but filesystem errors can still reject. Do not release references while a consumer still owns them.

Browser navigation, including back/forward-cache entry, revokes URLs. Select again on return. Saving a URL does not extend its lifetime, and release does not erase bytes or strings already held by JavaScript.

## Failed and interrupted work

A failed batch rejects without partial results and attempts to remove resources allocated for it. References from earlier successful requests remain independent. Filesystem failures and uncooperative provider reads can delay cleanup.

Native interrupted-transaction recovery runs when a copy first initializes the cache in a process. If termination occurs after committing a copy but before its ID reaches the application, the copy can remain until cache removal. Successful copies have no automatic expiration timer; release known IDs explicitly.

Reset invalidates request callbacks, and browser `pagehide` also revokes outstanding URLs. Processing is not a durable background job. For Android's restored picker results and platform-specific behavior, see [Platforms](PLATFORMS.md#restored-android-results).

## Names and content types

Display names and MIME types are descriptive metadata. Render names with text APIs such as `textContent`, validate contents in the component that processes them, and choose application-controlled destination names when saving elsewhere. A filter or filename extension does not establish that a file matches a format or is safe for its intended consumer.

## CSV, JSON, and provider filters

Start with the registered CSV type, [`text/csv`](https://www.iana.org/assignments/media-types/text/csv), or `application/json` for JSON. Providers may classify the same file differently. If a document is disabled, an explicit `'*/*'` request can help distinguish a type-registration problem from an unavailable document; validate the accepted contents in the application. A filename-based fallback after selection cannot enable a file that the picker disabled. Chooser neither silently broadens the requested filter nor enforces a file format after selection.

For a small UTF-8 CSV, decode the bytes before passing text to your application's CSV parser:

```js
async function chooseSmallCsv(parseCsv) {
  const file = await chooser.getFile('text/csv');
  if (file === undefined) return;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(file.data);
    return await parseCsv(text);
  } finally {
    if (file.id) {
      try {
        await chooser.releaseFile(file.id);
      } catch (error) {
        console.error('Could not release the selected file.');
        // Retain file.id if your application will retry cleanup.
      }
    }
  }
}
```

Call this helper directly from a user interaction after `deviceready` and handle its rejection. Choose the decoder to match the file's encoding. The application supplies a CSV parser that handles quoting, delimiters, and headers; `JSON.stringify(file.data)` serializes bytes, and `JSON.parse()` does not parse CSV. For large files, use a URI method with limits and an incremental reader/parser instead of decoding the whole file in JavaScript.
