# Troubleshooting

Start with the installed plugin and Cordova platform versions:

```sh
cordova plugin ls
cordova platform ls
cordova requirements
```

Reproduce with a small, nonprivate local file where possible. RC2 has a different API from RC1 and 1.x; check the [migration guide](MIGRATION.md) before debugging a wrapper or old example.

## Chooser or a method is undefined

Install the plugin into the Cordova app, load the generated `cordova.js`, and wait for `deviceready`. Adding an npm dependency alone does not install native integration. Prepare and rebuild after changing the plugin, and call the injected `chooser` directly when checking framework wrappers.

`getFileUri` and callback overloads were removed in RC2. Use `getFile` for a managed file or `getFileData` for complete contents.

## Invalid arguments or missing data

Pass an options object and the required byte budgets. `maxFileSize`, `maxTotalSize`, and `maxBytes` take positive safe integers or explicit `null`; zero is not unlimited in RC2. Unknown options and extra callback arguments reject with `INVALID_ARGUMENT`.

`getFile` returns reading methods, not a `data` field. `getFileData` returns only the requested representation. Metadata has no contents or managed URI. A fork-specific wrapper can have different names and signatures; see [wrapper migration](MIGRATION.md#awesome-cordova-plugins-and-fork-specific-wrappers).

## Cancellation is reported as an error

Expected cancellation is a typed exception. Catch `chooser.CancellationError` at the UI boundary and handle it quietly. Its reason is `'picker'` or `'signal'`. A `CleanupError` containing a canceled outcome also reports a resource-release failure and needs separate handling.

## The browser picker does not open or cancellation hangs

Call directly from a user gesture after `deviceready`, before awaiting timers or network work. Use Cordova Browser with the [required browser APIs](PLATFORMS.md#browser). Browsers without a file-input `cancel` event may leave dismissal pending; an operation supplied with an `AbortSignal` can be canceled by the app. The browser controls the visible native dialog.

## A second request rejects with BUSY

Wait for the active picker to settle. Provider work or an Android picker reservation can remain active after reset or a cancellation request. See [lifecycle behavior](PLATFORMS.md#lifecycle).

Use an `AbortSignal` to request cancellation rather than only racing the picker Promise against a timer. Cancellation may still wait for provider work to finish. For an unresponsive iOS Files UI, see the [known issue](KNOWN-ISSUES.md#intermittent-ios-files-selection).

## Files are missing or grayed out

Try `accept: '*/*'` to distinguish filtering from availability. A provider may use a different MIME type, require sign-in or connectivity, or expose only certain locations. Validate selected content in the app.

Use `source: 'photos'` for photo-library assets and the default document source for ordinary files. The Android photo fallback and browser file input can present a different UI from a dedicated photo library. Chooser does not select directories or iOS document packages.

## iOS preparation fails or the picker cannot appear

Set an explicit `deployment-target` of `15.0` or higher in the application's `config.xml`; an absent target fails preparation. Use Swift 5 language mode. See [build configuration](PLATFORMS.md#build-configuration).

Present from a visible app view after other modal transitions finish. Check supported orientations and wait for a previous request to settle. If Files remains open after a selection, see the [known Files issue](KNOWN-ISSUES.md).

## A URI cannot be read or stops working

For portable JavaScript reads, use the managed file's reading methods. WebView `fetch` is not a portable reader for native `file:` URIs. Check whether the ID was released, another alias released it, the cache was evicted, or browser navigation revoked the Blob URL.

`sourceUri` is borrowed and can lose access independently. Store important contents in persistent application storage rather than saving a temporary URI. See [reference lifetimes](FILE-HANDLING.md#reference-lifetimes).

## A stream stops with FILE_RELEASED

Release stops unfinished plugin streams across every alias of the file. Keep the managed file until processing is complete, or consume the stream inside `withFile` and await all its work. Returning a stream from the scoped function does not extend the resource lifetime.

## A browser preview is blocked

Check the console for Content Security Policy violations. The relevant directive needs `blob:` for Blob URL previews or fetches. See [CSP guidance](FILE-HANDLING.md#content-security-policy). Confirm that the reference is still live.

## Large files exhaust memory or exceed limits

Managed selection uses temporary storage; whole-file reads and direct-data methods still allocate complete results. Set budgets according to the app's needs and use streams for incremental processing. A byte limit is not a heap-size guarantee, especially for text or base64. Check free storage for native cache copies.

A failed batch returns no partial array. Handle reported cleanup failures separately from a file/count limit error.

## Text decoding fails

Text defaults to strict UTF-8. Choose the file's actual encoding, or set `fatal: false` if replacement characters are acceptable. Text ranges can cut through a multibyte character. Whole-file decoding and text streams handle chunk boundaries internally.

## Cleanup fails after processing succeeded

Inspect `CleanupError.outcome`. A fulfilled outcome contains the completed result; retrying the business operation can duplicate its effects. Retain `error.failures` and retry `releaseFiles` with those IDs when appropriate. Malformed IDs are not paths to repair: pass only opaque IDs returned by the plugin.

## An Android result disappears after activity recreation

The old Promise cannot receive a result after its WebView is destroyed. Cordova may deliver a raw result through `resume.pendingResult`; review [restored Android results](PLATFORMS.md#restored-android-results). It is not the ordinary public result and does not resume an interrupted upload.

## Report a reproducible issue

Open an [issue](https://github.com/cyph/cordova-plugin-chooser/issues) with plugin and platform versions, OS/browser, build tools, method/options, source/provider, expected result, and actual behavior. Include `ChooserError.code` where available. Say whether the problem occurs with a small local file, after cancellation, navigation, or activity recreation. Use synthetic files and remove credentials, file contents, personal filenames, and private URIs from logs.
