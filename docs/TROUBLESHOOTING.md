# Troubleshooting

First check the installed plugin and Cordova platform versions:

```sh
cordova plugin ls
cordova platform ls
cordova requirements
```

Reproduce with a small, nonprivate local file where possible. For method signatures and result fields, see the [API reference](API.md).

## Chooser or a method is undefined

Install the plugin in the Cordova app, load the generated `cordova.js`, and wait for `deviceready` before calling `chooser`. Adding an npm dependency alone does not install the native integration.

If `getFile()` exists but the multiple or URI methods do not, check the installed version and any framework wrapper. Install 2.0.0-rc.1, prepare and rebuild the app, and try the injected `chooser` directly. See [framework integration](MIGRATION.md#framework-and-lifecycle-integration).

## The browser picker does not open or cancellation hangs

Call the picker directly from a user gesture after `deviceready`, before awaiting a timer or network request. Use Cordova Browser and check the [browser requirements](PLATFORMS.md#browser). In particular, a browser that does not emit the file-input `cancel` event can leave a dismissed picker pending.

## A second request rejects with BUSY

Wait for the active request to settle before opening another picker. It remains active during reads or copies after the dialog closes, so disable the selection control until it finishes. A reset can also leave provider work or an Android picker reservation pending; see [lifecycle behavior](PLATFORMS.md#lifecycle).

If iOS Files stays open, follow the [known issue](KNOWN-ISSUES.md#intermittent-ios-files-selection). An app timeout or another picker call does not cancel the native request.

## An Android result disappears after activity recreation

The old Promise cannot receive a result after its WebView is destroyed. Cordova may deliver a raw result through `resume.pendingResult`; see [restored Android results](PLATFORMS.md#restored-android-results) for the payload and cleanup requirements.

## Files are missing or grayed out

Try `'*/*'` to check whether the provider's type mapping is limiting the listing. MIME filters are hints, so validate the file's contents in your application. Providers can require sign-in, connectivity, or a download. For CSV, `text/csv` is a useful starting filter; see [CSV, JSON, and provider filters](FILE-HANDLING.md#csv-json-and-provider-filters).

Android's single-file data and metadata methods prefer local providers. The newer multiple and URI methods allow remote providers by default. On iOS, Files and the Photos library expose different locations, and the document picker selects regular files rather than directories or document packages. See [platform selection rules](PLATFORMS.md).

## iOS cannot present the picker

Present from a visible app view after any other modal has finished dismissing, and check the app's supported orientations. If a previous request is still processing, wait for it to finish.

## iOS Files stays open after selecting a file

This has occurred intermittently in simulator tests. See the [iOS known issue](KNOWN-ISSUES.md#intermittent-ios-files-selection) for what is known and how to recover.

## A URI cannot be read or stops working

Use a consumer that supports the returned URI scheme. Native URI methods return private file copies; browser results use Blob URLs. WebView `fetch()` is not a portable reader for native `file:` URIs.

Check whether the ID was released before every consumer finished, the cache was removed, or browser navigation revoked the URL. A saved URI does not guarantee future access. To keep a file, copy it into persistent app storage. See [reference lifetimes](FILE-HANDLING.md#reference-lifetimes).

## Browser selection succeeds but a read or preview is blocked

Check the console for Content Security Policy violations. The applicable directive must allow `blob:`: for example, `connect-src` for `fetch()`, `img-src` for images, or `media-src` for audio and video. See the [CSP guidance](FILE-HANDLING.md#content-security-policy), then retry with a live reference.

## Large files exhaust memory or copies exceed limits

`getFile()` and `getFiles()` materialize whole files in memory and have no configurable size limit. Use a URI method with limits and a consumer that avoids reading the entire file into JavaScript. Check available storage for native cache copies.

Only URI methods accept copy options. Check the option names and byte units; unknown keys reject, and omitted or zero limits mean unlimited. Native copy limits count actual bytes even when provider metadata is inaccurate. See [copy options](API.md#copy-options).

## A wrapper reports missing data or the call rejects before selection

Confirm the method and arguments match this plugin's [API](API.md). Data methods return `data` and `dataURI`; metadata and URI methods do not. Unknown copy-option keys and invalid filters reject. Failure values may be strings or `Error` objects, so treat them as `unknown`; diagnostic prefixes are not stable typed error codes.

The Awesome Cordova Plugins Chooser wrapper targets a different fork. See [wrapper migration guidance](MIGRATION.md#awesome-cordova-plugins-and-fork-specific-wrappers) for direct calls.

## Releasing a reference fails

Pass the opaque `id` returned by the plugin, not a URI or a value constructed from its path. Every browser result has an ID; native results have one only for URI methods. Release only plugin-owned references after all consumers finish. Malformed IDs and filesystem errors can reject; retain an ID if your app needs to retry cleanup. Browser IDs do not survive a page session.

## The application fails to build

Check the Cordova platform's JDK, SDK, Node, and Xcode requirements, and the requirements of other installed plugins. On iOS, check Swift mode and the deployment target. The [platform guide](PLATFORMS.md#requirements-and-coverage) links to Cordova's setup guides.

## Report a reproducible issue

Open an [issue](https://github.com/cyph/cordova-plugin-chooser/issues) with the plugin and Cordova platform versions, OS or browser, build-tool versions, method and options, provider, expected result, and actual behavior. Say whether the issue occurs with a small local file or after cancellation, navigation, or activity recreation. Use synthetic files and remove credentials, contents, personal filenames, and private URIs from any logs.
