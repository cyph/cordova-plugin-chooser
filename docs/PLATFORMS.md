# Platform guide

Picker UI, providers, and source-URI lifetime vary by platform. See [API](API.md) for the shared signatures and [File handling](FILE-HANDLING.md) for ownership.

## Requirements and coverage

The plugin declares `cordova-android >=14.0.0` and `cordova-ios >=7.0.0` in [plugin.xml](../plugin.xml). The maintained families and their platform-defined OS floors are:

| Cordova platform | Platform OS requirement |
| --- | --- |
| Android 14.x / 15.x | Android 7.0 / API 24 or later |
| iOS 7.x | iOS 11 or later |
| iOS 8.x | iOS 13 or later |
| Browser 7.x | Browser features described below |

Follow Cordova's [Android](https://cordova.apache.org/docs/en/latest/guide/platforms/android/) or [iOS](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) toolchain requirements. Minimum engine constraints do not establish qualification for future platform versions.

The repository builds Android 14/15 and iOS 7/8 applications and exercises Cordova Browser 7. Its Cordova iOS application fixtures use Swift 5 mode and an iOS 15.0 deployment target. Those fixtures do not establish qualification for older deployment targets, even though source fallbacks remain. Your Xcode version and other dependencies may impose a higher OS floor than Cordova itself. [Verification](VERIFICATION.md) distinguishes automated coverage from device/provider checks.

## Android

### Selection and providers

Chooser uses `ACTION_GET_CONTENT` with `CATEGORY_OPENABLE` and a temporary read grant. It accepts provider `content:` URIs and does not request blanket storage or media permissions. It does not acquire a persistent document grant.

| Methods | Provider preference |
| --- | --- |
| `getFile()`, `getFileMetadata()` | Request local providers with `EXTRA_LOCAL_ONLY` |
| `getFiles()`, `getFilesMetadata()` | Allow remote providers |
| `getFileUri()`, `getFilesUri()` | Allow remote providers; `{localOnly: true}` requests local files |

The local-only setting is a picker preference. Providers determine what appears, and cloud providers may require authentication, connectivity, downloads, or export conversion. Some providers allow only one selection even when multiple selection is requested; a successful plural call still returns an array.

Metadata uses the provider's display name and reported size, with `File` as the fallback name and `null` for an unavailable size. MIME type comes from the provider or filename extension, then falls back to `application/octet-stream`. A managed copy's `sourceUri` records the provider URI; its `uri` refers to the private copy and its size counts actual bytes copied.

### Lifecycle

The active request includes processing after the visible picker closes. Reset invalidates its callback and requests cancellation of provider work. An outstanding picker retains its reservation until the activity result returns, so a new request can remain busy after a WebView reset.

A JavaScript Promise cannot survive destruction of its WebView. Restoring the picker result does not restore arbitrary interrupted reads, uploads, or application work.

### Restored Android results

Cordova can deliver a recovered picker result in `event.pendingResult` on the [`resume` event](https://cordova.apache.org/docs/en/latest/guide/platforms/android/#retrieving-plugin-callback-results-cordova-android-510). Applications supporting this path should register a listener during startup and retain enough application state to identify the original method.

Check `pendingResult.pluginServiceName === 'Chooser'` and inspect `pluginStatus`. An `'OK'` result contains the native payload, which bypasses the normal JavaScript wrapper:

| Payload | Required handling |
| --- | --- |
| `'RESULT_CANCELED'` | Interpret as cancellation; it is not yet `undefined` |
| JSON-encoded object or array | Parse and validate according to the original method |
| Data-mode object | `data` is base64 text; it has not become a `Uint8Array`, and `dataURI` has not been constructed |
| URI-mode object | Retain the managed ID during consumption and release it afterward, including when discarding the result |

Other statuses represent errors. Normal resume events need not contain a result, and recovery is not guaranteed after every termination. Avoid opening another picker solely because the old Promise is gone. Recovery policy belongs to the application's workflow; Chooser provides no API to query an outstanding operation or enumerate lost references.

## iOS

### Build configuration

Use Swift 5 language mode, as the repository's builds do. In the application's `config.xml`:

```xml
<platform name="ios">
  <preference name="SwiftVersion" value="5.0" />
</platform>
```

Choose `deployment-target` to suit your application and Xcode; the fixtures use `15.0`. Cordova iOS 7 and later supply Swift integration, so Chooser does not require `cordova-plugin-add-swift-support`.

### Document access and presentation

The system document picker selects regular files from Files and document providers. It is not a camera, Photos-library, directory, or document-package picker. Metadata and data methods ask the OS to import a copy; even metadata selection may therefore cause a provider download. URI methods open the document, coordinate a read, and stream into private cache.

Chooser obtains security-scoped access during the read and releases it afterward. It does not create a persistent bookmark. Source/import URIs should not be treated as permanent access grants.

The presenting app view must be visible and ready to present a controller. Finish dismissing other modals first. iPad presentation is anchored to the app view, and picker orientation follows the app's supported orientations. Provider reads abandoned by reset can occupy worker capacity until they return, temporarily causing further requests to reject with `BUSY`.

### Types and privacy

MIME filters map to system type identifiers. Common wildcards include images, audio, video, text, and fonts; unknown types can broaden selection. The returned name is the file's last path component, and MIME type is inferred from the extension. Directories and file packages fail the regular-file check.

The package includes `ChooserPrivacy.bundle/PrivacyInfo.xcprivacy`, declaring file-timestamp API access with reason `C617.1`, no tracking, and no collected-data types. Its bundle is separate from the app's privacy manifest. Your app must declare its own behavior and that of other dependencies; see Apple's [required-reason API guidance](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).

## Browser

Use the Cordova browser platform with Promises, typed arrays, `FileReader`, Blob URL creation/revocation, Web Crypto, and file-input [`cancel` events](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/cancel_event).

Invoke the picker directly from a click or other user interaction after `deviceready`, before awaiting network requests or timers. The plugin opens the input synchronously. Without `cancel` event support, dismissing a dialog can leave the request pending; there is no timer-based cancellation fallback.

All results contain a Blob URL and managed ID, including metadata and data results. URI methods reference selected `File` objects without a native filesystem copy. Browsers do not expose the original path, so `sourceUri` is absent. Limits use `File.size`, and `localOnly` has no effect.

The application's [Content Security Policy](FILE-HANDLING.md#content-security-policy) must permit Blob URLs for any reads or previews that consume them.

Release references after use. `pagehide` cancels the active operation and revokes outstanding URLs, including when navigating into the back/forward cache. See [reference lifetimes](FILE-HANDLING.md#reference-lifetimes) before persisting results.
