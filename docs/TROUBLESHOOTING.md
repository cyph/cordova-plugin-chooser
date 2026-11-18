# Troubleshooting

First identify the package and platform actually installed. In Capacitor, synchronize after changing a plugin and rebuild the app.

```sh
npm ls cordova-plugin-chooser
npx cap sync
npx cap ls
```

For Cordova, check the plugin, platform, and build prerequisites.

```sh
cordova plugin ls
cordova platform ls
cordova requirements
```

The remedies below use the RC2 API. Consult [migration](MIGRATION.md) for earlier releases. Reproduce with a small nonprivate local file before introducing cloud providers or large inputs.

## Chooser or a method is undefined

In Capacitor, confirm the package is installed, run sync, and rebuild the native app. In Cordova, install the plugin into the app and load the generated `cordova.js`. Both need `deviceready` before calls to the injected `chooser`. Installing an npm dependency alone does not create native integration or a standalone web picker.

Check the installed version and call the global directly when investigating a wrapper. RC2 uses `getFile` for a managed handle and `getFileData` for complete contents. RC1's `getFileUri` and callback overloads are absent in RC2.

<a id="a-wrapper-reports-missing-data-or-the-call-rejects-before-selection"></a>

## Invalid arguments or missing data

Use an options object with the required budgets. `maxFileSize`, `maxTotalSize`, and whole-file `maxBytes` take positive safe integers or explicit `null`. Unknown keys, zero byte limits, and old callback arguments reject. A wrapper for another fork may use different argument and result names. See [wrapper migration](MIGRATION.md#awesome-cordova-plugins-and-fork-specific-wrappers).

RC2 `getFile` returns a managed handle, not a `data` property. Choose a format with `getFileData`, or read the handle. Metadata returns no contents. Only managed results have a releasable ID and URI.

## Cancellation is reported as an error

RC2 represents dismissal as `CancellationError` with code `CANCELLED`. Catch it at the interface boundary. `reason` identifies a picker dismissal or signal cancellation. A `CleanupError` can contain a canceled outcome and also reports failed cleanup, which requires separate handling.

## The browser picker does not open or cancellation hangs

Start the picker directly in a click or other user gesture after `deviceready`. Awaiting a timer or network call before opening it can lose the gesture. Check the [browser requirements](PLATFORMS.md#browser). Some browsers do not emit the file-input cancellation event, leaving dismissal pending. A supplied `AbortSignal` lets the application request cancellation.

## A second request rejects with BUSY

Wait for the active picker and any cancellation to settle. An Android activity result or provider work can remain outstanding after reset. Use an `AbortSignal` to request cancellation rather than only racing the Promise against a timeout. Provider I/O may take time to finish. For an unresponsive Files dialog, see the [known iOS issue](KNOWN-ISSUES.md#intermittent-ios-files-selection).

## Files are missing or grayed out

Try `accept: '*/*'` to test whether a MIME filter is responsible. A provider might classify an item differently, require sign-in or network access, or restrict its locations. Validate contents after selection. Use the photo source for a library picker and documents for ordinary files. The browser and Android fallback can present different interfaces.

<a id="ios-cannot-present-the-picker"></a>
<a id="ios-files-stays-open-after-selecting-a-file"></a>
<a id="the-application-fails-to-build"></a>

## iOS preparation fails or the picker cannot appear

Cordova requires an explicit iOS deployment target of at least 15 in `config.xml`. The project is tested in Swift 5 language mode, which the host may already select. The Cordova hook validates the deployment target, not the Swift setting. Capacitor does not run that hook. Configure the native target yourself and keep any higher host requirement. See [build configuration](PLATFORMS.md#build-configuration).

Present the picker from a visible view after other modal transitions. Check orientation support and whether a previous request is still active. If Files stays open after selecting or dismissing, consult the [known issue](KNOWN-ISSUES.md).

## A URI cannot be read or stops working

For portable JavaScript reads, use the managed handle's methods. Native `file:` URIs do not have portable WebView `fetch` support. Check for release through another alias, native cache eviction, or browser navigation. A `sourceUri` is borrowed and can expire independently. Copy data into persistent app storage if it must survive the cache.

## A stream stops with FILE_RELEASED

Release closes all aliases and stops unfinished plugin streams. Await the stream and any external URI users before releasing, or finish that work inside `withFile`. Returning a stream from its callback does not extend its lifetime.

<a id="browser-selection-succeeds-but-a-read-or-preview-is-blocked"></a>

## A browser preview is blocked

Check the console for a Content Security Policy violation and allow `blob:` in the directives used by the preview or fetch. Confirm the handle has not been released or revoked by navigation. See [CSP guidance](FILE-HANDLING.md#content-security-policy).

<a id="large-files-exhaust-memory-or-copies-exceed-limits"></a>

## Large files exhaust memory or exceed limits

A managed selection uses temporary storage, while direct data and whole-file reads allocate complete results. Choose budgets for both storage and memory and use streams for incremental work. A byte limit does not guarantee a particular heap footprint, especially for text or base64. Check available native cache space. A failed batch returns no partial array.

## Text decoding fails

The default is strict UTF-8. Set the actual `encoding` or use `fatal: false` if replacement characters are acceptable. These are top-level options for text reads and text-format data. A byte range can split a character. Text streams preserve characters across their own chunks.

<a id="releasing-a-reference-fails"></a>

## Cleanup fails after processing succeeded

Inspect `CleanupError.outcome` before retrying the business operation. A fulfilled outcome means processing already succeeded. Retain the failed IDs from `failures` and retry release as appropriate. Batch release requires a dense array of valid opaque IDs and validates it before changing resources.

## An Android result disappears after activity recreation

A destroyed WebView cannot receive the old Promise result. Cordova may provide a raw envelope in `resume.pendingResult`. It is not a public result or a resumed upload. See [restored Android results](PLATFORMS.md#restored-android-results).

## Report a reproducible issue

Open an [issue](https://github.com/cyph/cordova-plugin-chooser/issues) with plugin and platform versions, OS and build tools, method and options, provider, expected behavior, actual behavior, and `ChooserError.code` when available. Mention whether cancellation, navigation, or activity recreation was involved. Use synthetic files and remove credentials, private URIs, file contents, and personal filenames from logs.
