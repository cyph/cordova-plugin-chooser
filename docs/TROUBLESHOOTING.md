# Troubleshooting

Start with the installed plugin and Cordova platform versions:

```sh
cordova plugin ls
cordova platform ls
cordova requirements
```

Match the documentation to the package you installed. Reproduce the problem with a small, nonprivate local file before adding cloud-provider or large-file complexity.

## Chooser or a method is undefined

Load Cordova's generated `cordova.js`, install the plugin into the Cordova application, and wait for `deviceready`. An npm dependency by itself does not install the native integration.

If `getFile()` exists but the multiple-selection or URI methods do not, check for a 1.x installation or an older framework wrapper. Install the exact [RC1 version](../README.md#installation), then prepare and rebuild the app. Call the injected `chooser` directly to distinguish wrapper coverage from plugin behavior.

## The browser picker does not open or cancellation hangs

Call the picker directly from a user interaction, before an unrelated `await`, network request, or timer. Use Cordova Browser so its proxy is registered. Confirm support for the [required browser features](PLATFORMS.md#browser), particularly file-input `cancel` events. There is no timeout fallback for a browser that omits that event.

## A second request rejects with BUSY

Wait for the active request to settle before opening another picker. Its work includes reading or copying after the visible dialog closes. Disable selection controls during that period.

Reset can leave provider work pending; Android can also retain an outstanding picker reservation. Repeated calls do not cancel that work. Review [platform lifecycle behavior](PLATFORMS.md#lifecycle) and provider availability. The public API has no cancel or timeout operation.

## An Android result disappears after activity recreation

The old Promise cannot receive the result. Handle Cordova's raw `resume.pendingResult` channel as described in [restored Android results](PLATFORMS.md#restored-android-results). An ordinary resume event without a result does not imply a new selection is needed.

## Files are missing or grayed out

Try `'*/*'` to distinguish filter/type-registration differences from provider availability. Continue validating accepted contents in the consumer. Providers may require sign-in, connectivity, or a download.

Android's legacy single-file methods prefer local providers; use a URI method with its default remote-provider allowance when appropriate. iOS uses the document picker, so items available only in Photos may not appear. Directories and document packages are outside the regular-file contract. See [Platforms](PLATFORMS.md) for the selection rules.

## iOS cannot present the picker

Open it from a visible application view after another modal has finished dismissing. Check the app's supported orientations on iPhone and iPad. A dismissed dialog can still have a request processing provider data, so wait for that request's completion before trying again.

## A URI cannot be read or stops working

Use a consumer supporting the returned URI scheme. A `content:` URI or Blob URL is not a path, and WebView `fetch()` is not a portable reader for native `file:` URIs.

Check whether the reference was released too early, the cache was removed, or browser navigation revoked its URL. Saving a URI does not preserve access. Use [file-handling guidance](FILE-HANDLING.md#reference-lifetimes) to choose persistent storage when needed.

## Browser selection succeeds but a read or preview is blocked

Check the browser console for Content Security Policy violations. The application must permit `blob:` in the directive for its consumer: `connect-src` for `fetch()`, `img-src` for images, or `media-src` for audio/video. Merge the required sources into the existing policy using the [CSP guidance](FILE-HANDLING.md#content-security-policy), then retry with a live reference. Selection and metadata inspection can succeed while the policy blocks subsequent consumption.

## Large files exhaust memory or copies exceed limits

Data methods materialize complete contents. Prefer URI methods with limits and a consumer that avoids loading the entire file into JavaScript. A larger Android heap cannot make whole-file allocation safe for arbitrary sizes.

Only URI methods accept limit options. Check spelling, units, and free storage; unknown properties are ignored and zero means unlimited. Native limits count actual bytes despite inaccurate metadata. See [copy options](API.md#copy-options).

## Releasing a reference fails

Pass the returned `id`. Native data/metadata results have none; every browser result does. Malformed IDs and filesystem failures reject.

Keep cleanup failures separate from the consumer's outcome. If your application retries native cleanup, retain the returned ID until release succeeds. Never queue references still in use or infer IDs from paths. Browser IDs cannot be reused in a later page session.

## The application fails to build

Match the installed Cordova platform to its required JDK, SDK, Node, and Xcode versions. Review iOS Swift and deployment-target settings and requirements imposed by other plugins. Adding broad storage permissions or `largeHeap` does not resolve toolchain incompatibilities. The [platform guide](PLATFORMS.md#requirements-and-coverage) links to the official requirements.

## Report a reproducible issue

Include the plugin version or commit, Cordova platform version, OS/browser and build-tool versions, method/options, provider type, expected result, and actual behavior. State whether a small or empty local file reproduces the issue and whether it follows cancellation, navigation, or activity recreation.

Use synthetic files. Redact credentials, contents, personal filenames, and private URIs from errors and logs before posting an [issue](https://github.com/cyph/cordova-plugin-chooser/issues).
