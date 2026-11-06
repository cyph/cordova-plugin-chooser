# Platform guide

Chooser uses the platform's document picker. Provider availability, presentation, and the lifetime of returned URIs differ across Android, iOS, and Browser. The [API reference](API.md) describes the shared methods; [file handling](FILE-HANDLING.md) covers consuming and releasing results.

## Requirements and coverage

The plugin requires `cordova-android >=14.0.0` or `cordova-ios >=7.0.0` when those platforms are installed. The maintained platform families have these platform-defined OS minimums:

| Cordova platform | Platform OS minimum |
| --- | --- |
| Android 14.x and 15.x | Android 7.0 (API 24) |
| iOS 7.x | iOS 11 |
| iOS 8.x | iOS 13 |
| Browser 7.x | Browser capabilities described below |

Follow the Cordova [Android](https://cordova.apache.org/docs/en/latest/guide/platforms/android/) and [iOS](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) guides for the appropriate build tools. Other dependencies or your Xcode version can require a higher OS version. The repository's iOS application fixtures use Swift 5 mode and an iOS 15.0 deployment target; that target is separate from Cordova's platform minimums and does not establish coverage for earlier targets.

## Android

### Selection and providers

Chooser requests openable documents through `ACTION_GET_CONTENT`, using a temporary read grant. It needs no broad storage or media permission and does not obtain a persistent document grant.

| Methods | Provider preference |
| --- | --- |
| `getFile()`, `getFileMetadata()` | Prefer local providers |
| `getFiles()`, `getFilesMetadata()` | Allow remote providers |
| `getFileUri()`, `getFilesUri()` | Allow remote providers; `localOnly: true` requests local providers |

The local preference uses `EXTRA_LOCAL_ONLY`; the picker and provider decide whether to honor it. Remote providers can require sign-in, connectivity, downloads, or format conversion. A provider may allow only one selection in a multiple picker; plural methods still return a nonempty array when a file is selected.

Metadata includes the provider's display name and size when available. The fallback name is `File`, and an unknown size is `null`. The MIME type comes from the provider or filename extension, with `application/octet-stream` as a fallback. For URI methods, `sourceUri` identifies the provider URI, while `uri` identifies the private cache copy; its `size` is the actual number of bytes copied.

### Lifecycle

Only one picker request can be active, including the time spent reading or copying after the picker closes. A WebView reset invalidates the callback and requests cancellation of provider work. An open Android picker keeps its reservation until its activity result returns, so another request can still encounter `BUSY` after reset.

A Promise cannot survive destruction of its WebView. Cordova may restore a picker result, but it cannot resume the application's interrupted processing or uploads.

### Restored Android results

Register a listener during startup if your app handles activity recreation. Cordova may deliver the result in `event.pendingResult` on [`resume`](https://cordova.apache.org/docs/en/latest/guide/platforms/android/#retrieving-plugin-callback-results-cordova-android-510). Keep enough application state to identify the method that started the request.

Check `pendingResult.pluginServiceName === 'Chooser'` and `pendingResult.pluginStatus`. For an `'OK'` status, `pendingResult.result` contains the raw native payload, before the JavaScript wrapper processes it:

| Payload | Handling |
| --- | --- |
| `'RESULT_CANCELED'` | Treat as cancellation; it has not been converted to `undefined`. |
| JSON-encoded object or array | Parse it according to the original method. |
| Data result | `data` is base64 text, not a `Uint8Array`; `dataURI` has not been constructed. |
| URI result | Keep its managed ID until consumers finish, then release it, including when discarding the result. |

Other statuses indicate errors. Ordinary resume events may have no pending result, and recovery is not guaranteed for every interruption. There is no public API to query an outstanding operation or enumerate lost references.

## iOS

### Build configuration

Use Swift 5 language mode in the app's `config.xml`:

```xml
<platform name="ios">
  <preference name="SwiftVersion" value="5.0" />
</platform>
```

Choose a `deployment-target` compatible with the app, its dependencies, and Xcode. The repository fixtures use `15.0`. Cordova iOS 7 and later provide Swift integration; Chooser does not require `cordova-plugin-add-swift-support`.

### Document access and presentation

The document picker selects regular files from Files and document providers. It does not select directories or document packages, and it is not a camera or Photos-library picker. Present it from a visible app view after other modal transitions finish. On iPad it is anchored to the app view; its orientation follows the app's supported orientations.

For data and metadata methods, the OS imports a copy and may download it even when only metadata is requested. The plugin does not read the full file for metadata. URI methods open the selected document, coordinate the read, and stream a copy into private cache. Security-scoped access is used during the read and then released; no persistent bookmark is created.

A request remains active while provider work completes. After a reset, abandoned provider reads can temporarily occupy worker capacity and cause later requests to encounter `BUSY`. See the [known iOS selection issue](KNOWN-ISSUES.md#intermittent-ios-files-selection) if Files remains open.

### Types and privacy

MIME filters are mapped to system type identifiers. The mapping includes common image, audio, video, text, and font wildcards; unknown types can broaden selection. Names come from the last path component and MIME types are inferred from extensions. Filters are selection hints, not content validation.

The plugin includes `ChooserPrivacy.bundle/PrivacyInfo.xcprivacy`. It declares file-timestamp API access with reason `C617.1`, no tracking, and no collected-data types. This bundle is separate from the app's privacy manifest; the app must account for its own behavior and other dependencies. See Apple's [required-reason API guidance](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).

## Browser

Using Chooser with Cordova Browser requires Promises, typed arrays, `FileReader`, Blob URL creation and revocation, Web Crypto, and file-input [`cancel` event](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/cancel_event) support. Without the cancel event, dismissing the picker can leave the request pending.

After `deviceready`, invoke the picker directly from a click or other user gesture, before awaiting a timer or network request. Only one request can be active at a time.

Every browser result has a managed ID and a Blob URL, including data and metadata results. URI methods reference the selected `File` without making a native cache copy. The browser does not expose the original path, so URI results have no `sourceUri`; limits use `File.size`, and `localOnly` has no effect.

Release each ID after all consumers finish. URLs also expire on `pagehide`, including navigation into the back/forward cache. Do not rely on them as persistent references. The app's [Content Security Policy](FILE-HANDLING.md#content-security-policy) must allow `blob:` for the relevant reader or preview. See [reference lifetimes](FILE-HANDLING.md#reference-lifetimes).
