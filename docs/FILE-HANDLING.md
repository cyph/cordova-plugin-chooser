# File handling

Choose a method based on what will consume the selection. Metadata methods provide names, types, URIs, and reported sizes without a full-file read by the plugin. Data methods make the contents available in JavaScript. URI methods provide temporary references with optional size and count limits. Every call opens a new selection, so inspecting metadata first does not reserve a file for a later call.

## Memory and storage

`getFile()` and `getFiles()` read entire files and provide both bytes and base64 data URIs. Base64 is roughly one third larger than the original, and buffers, bridge strings, and JavaScript values can coexist. Multiple files increase the cost. These methods have no configurable size limits; checking `size` after the call cannot prevent the read or its memory use. They are best suited to small files.

For unknown or larger inputs, use a URI method with [copy limits](API.md#copy-options). Android and iOS stream the contents into private cache files without loading each complete copy into memory. The copies use storage, and an OS or provider may use additional resources to import or download a file. The limits apply to accepted counts and bytes, not provider time or resource use. Browser URI results are Blob URLs for selected `File` objects; they do not require a full read to create the reference.

A consumer can still load a whole file after selection. Use a streaming reader and parser where available if the application needs to keep its own memory use bounded.

## Consume, then release

A managed ID belongs to the plugin resource returned with it. Keep the resource until every reader, upload, preview, or copy using it has finished, then call `releaseFile(id)`. All browser results have an ID, even when only metadata or data was requested. On Android and iOS, only URI results have an ID.

This helper selects up to four files, with limits of 10 MiB per file and 25 MiB total. The supplied `consumeFiles` function must settle only after all its consumers have finished, including on failure:

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
        console.error('Could not release a selected file.', error);
        // Retain file.id if the application will retry cleanup.
      }
    }));
  }
}
```

Call the helper directly from a user interaction after `deviceready`, and handle its rejection. Cleanup failures are handled separately so they do not hide a processing failure. Release only the resources identified by IDs returned to your app; the original selected file is not removed.

When consumers run in parallel, `Promise.all()` can reject before the others finish. Wait for every consumer to settle before allowing `consumeFiles` to settle, using `Promise.allSettled()` where supported or processing sequentially.

### Native consumers

Native URI methods return private `file:` URIs. Pass them to a native reader, uploader, or storage integration that accepts local file URIs. WebView `fetch(file.uri)` is not a portable native-file reader. To keep a file, copy it to application-managed persistent storage before release. To share it with another app, use a sharing integration; Android commonly needs a `FileProvider` and temporary grant, as described in [Android's file-sharing guide](https://developer.android.com/training/secure-file-sharing/share-file).

### Browser consumers

A live Blob URL can be used by supported preview elements or read with `fetch(file.uri)`. Wait until the preview is no longer needed or the read has completed before release. Methods such as `response.text()`, `response.blob()`, and `response.arrayBuffer()` consume the full response; use supported response-body streaming for incremental processing.

For inspection, read `name`, `mediaType`, and `size` from the result. Even if you never use its URI, release the ID from a browser metadata or data result.

### Content Security Policy

The application's Content Security Policy must allow `blob:` for each consumer that uses a Blob URL. For example, add it to `connect-src` for `fetch()`, `img-src` for image previews, or `media-src` for audio and video previews. This fragment allows same-origin connections and images as well as Blob URL reads and image previews:

```text
connect-src 'self' blob:;
img-src 'self' blob:;
```

Merge the needed sources into the app's existing directives and retain its other trusted origins. This is a fragment, not a complete policy. See the [CSP specification](https://www.w3.org/TR/CSP3/#directive-connect-src).

## Reference lifetimes

| Result | Reference | Cleanup |
| --- | --- | --- |
| Native data or metadata | Source/import URI controlled by the OS or provider | No managed ID |
| Native URI | Private cache copy, until released or removed from cache | Release its ID |
| Any browser result | Blob URL for the current page, until released or `pagehide` | Release its ID |

None of these URIs is a guarantee of persistent access. Native copies are snapshots and do not follow later source changes. Cache files can be evicted, including copies that survive an app restart. Store important contents in persistent application storage and retain the display name and media type separately; generated cache names do not carry a meaningful extension.

IDs are opaque: save and pass them back unchanged. A repeated release normally succeeds when the resource is already absent, although filesystem failures can reject. Browser navigation, including entry into the back/forward cache, revokes outstanding URLs; select again on return. Releasing a Blob URL does not erase bytes or strings already held by JavaScript.

## Failed and interrupted work

A failed multiple selection returns no partial array and the plugin attempts to clean up resources created for that request. Filesystem failures or unfinished provider work can delay cleanup. Earlier successful results remain separately owned and still need release.

A reset invalidates request callbacks, and browser `pagehide` also revokes outstanding URLs. Interrupted native work is not a durable background job. A copy committed before an interruption but not delivered to the app may remain until cache removal. See [platform lifecycle behavior](PLATFORMS.md#lifecycle) for details.

## Names and content types

Names and MIME types describe the selected item; neither proves the content's format or safety. Render names using text APIs such as `textContent`, choose application-controlled names when saving files, and validate content in the component that consumes it. MIME filters are selection hints, not content validation.

## CSV, JSON, and provider filters

Use `text/csv` for CSV or `application/json` for JSON as a starting point. Providers may classify a document differently. If a file is disabled, selecting with `'*/*'` can help identify a filter mismatch; check the contents after selection. See [iOS type mappings](PLATFORMS.md#ios).

For a small UTF-8 CSV, decode the bytes and pass the text to a CSV parser:

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
        console.error('Could not release the selected file.', error);
        // Retain file.id if the application will retry cleanup.
      }
    }
  }
}
```

Call this helper directly from a user interaction after `deviceready` and handle its rejection. Supply a parser that understands CSV quoting, delimiters, and headers; `JSON.parse()` parses JSON, not CSV. Choose the decoder for the file's encoding. For large files, use a limited URI selection and an incremental reader and parser.
