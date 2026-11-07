# Platform guide

Chooser uses system document and photo pickers. The shared API provides metadata, managed files, and direct data, while the OS and providers determine what is available and how it is presented.

## Requirements and coverage

| Maintained Cordova platform | Application requirement |
| --- | --- |
| Android 14.x and 15.x | Android 7.0 (API 24) or later |
| iOS 7.x and 8.x | iOS 15 or later; Swift 5 language mode |
| Browser 7.x | Browser capabilities listed below |

The declared native engine minimums are Cordova Android 14 and Cordova iOS 7. Chooser's iOS 15 requirement applies even when the Cordova platform itself supports earlier iOS versions. Follow Cordova's [Android](https://cordova.apache.org/docs/en/latest/guide/platforms/android/) and [iOS](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) guides for the matching build tools. Other app dependencies may require higher versions.

The [verification guide](VERIFICATION.md) describes automated lanes and their boundaries. Builds and controlled provider tests do not establish compatibility with every cloud provider or physical device.

## Android

### Documents and providers

The default document source requests openable documents with temporary read access. Chooser needs no broad storage permission and does not obtain a persistent document grant. Local and remote providers are allowed by default. `localOnly: true` requests local providers through `EXTRA_LOCAL_ONLY`; the picker or provider decides how to honor it.

Remote providers can require sign-in, connectivity, downloads, or format conversion. Some providers allow only one selection even in a plural picker; the result is still an array. `sourceUri` identifies the borrowed provider reference, while a managed `uri` identifies the plugin's private copy.

### Photos and videos

`source: 'photos'` uses Android's Photo Picker when available, with a supported document-picker fallback. The fallback UI can differ and may not enforce the requested selection count; Chooser checks the returned count. Availability depends on Android's version and installed picker components.

Photo selection uses temporary access to the selected media without broad photo-library or media-storage permissions. It does not capture new photos or videos. Use the document source for images and videos stored as ordinary documents when that is the desired browsing experience.

### Lifecycle

Only one picker request can be active. A reset invalidates callbacks and requests cancellation of provider work. Android can retain a picker reservation until its activity result returns, so an immediate new request may still receive `BUSY`.

A Promise cannot survive destruction of its WebView. Cordova may restore a picker result, but it cannot resume the application's interrupted JavaScript processing or uploads.

### Restored Android results

Applications handling activity recreation can listen for `resume.pendingResult`. Check `pluginServiceName === 'Chooser'` and `pluginStatus` before interpreting the result. This is a raw Cordova/native payload, not the public JavaScript result, and is not a replacement for the Promise API.

A restored managed-copy payload can be parsed and passed to `restoreFile`; release its managed ID if discarding it. Metadata has no managed resource. Direct-data selection uses temporary source readers internally: a raw source-reader result is not a `FileData` value and cannot be restored as a managed file. Release any returned source IDs and ask the user to select again. A raw `RESULT_CANCELED` indicates cancellation.

Keep enough app state to identify the interrupted operation. Recovery is not guaranteed for every interruption, and there is no API to enumerate lost references.

## iOS

### Build configuration

Set these application `config.xml` preferences before plugin installation or preparation:

```xml
<platform name="ios">
  <preference name="deployment-target" value="15.0" />
  <preference name="SwiftVersion" value="5.0" />
</platform>
```

Keep an existing higher target. Chooser's prepare hook rejects an absent deployment target or one below 15; it does not silently change the application target. Cordova iOS supplies Swift integration, so Chooser does not need `cordova-plugin-add-swift-support`.

### Documents and presentation

The document source selects regular files from Files and document providers. It does not select directories or document packages. Present it from a visible app view after other modal transitions finish. The picker follows the app's supported orientations and uses an appropriate anchor on iPad.

Reads use coordinated, security-scoped access where required. Managed selection copies into private cache; the provider or OS may import or download a document for other modes as well. Metadata does not trigger a full-content read in plugin code. No persistent security-scoped bookmark is created.

Provider operations can outlive a cancellation request or reset. See the [known Files issue](KNOWN-ISSUES.md#intermittent-ios-files-selection) if selection remains pending.

### Photos and videos

Use `source: 'photos'` to select from the Photos library through `PHPickerViewController`. Set `mediaTypes: ['image']` or `['video']` to narrow the choice. This picker grants access to selected items without requiring broad photo-library permission. Chooser does not request camera access or add capture, editing, or transcoding controls.

The picker prefers the current representation; Chooser does not decode and re-encode images. The system or provider may still supply a converted representation, so this is not a guarantee of original encoded bytes.

Provider file representations are temporary. For direct-data methods, Chooser stages a copy in app-private cache before the provider callback returns, then reads it and removes it automatically. This adds a copy step and temporary storage proportional to the selected representations, potentially alongside the provider's own temporary files. There is no caller release obligation for the returned data; cleanup failures surface as `CleanupError`. See [memory and storage](FILE-HANDLING.md#memory-and-storage).

Photos metadata can lack an exact size or other details. The metadata methods do not load a full representation just to discover them; unknown size is `null`. Choose a managed file when you need content and an actual byte count.

### Types and privacy

Document MIME filters map to system type identifiers, including common wildcards and iWork types. Unknown mappings can broaden selection. Media types and names are descriptive metadata, not content validation.

The plugin includes a separate `ChooserPrivacy.bundle/PrivacyInfo.xcprivacy`, declaring file-timestamp API access with reason `C617.1`, no tracking, and no collected-data types. The app remains responsible for declarations covering its own behavior and other dependencies.

## Browser

Use Cordova Browser with Promises, typed arrays, `File`/`Blob` APIs including `slice()` and `arrayBuffer()`, Blob URLs, Web Crypto, `AbortController`, `ReadableStream`, `TextDecoder`, and file-input `cancel` event support. Without the input cancellation event, dismissing a dialog may leave selection pending until the application aborts it.

After `deviceready`, call a picker directly from a click or another user gesture, before awaiting network work or a timer. The plugin's scoped helpers preserve this gesture requirement.

`source: 'photos'` requests image/video types through a file input. The browser and OS choose the UI; a dedicated photo-library interface is not guaranteed. Browser results never expose an original filesystem path. `localOnly` has no effect.

Managed selection retains the selected `File` and creates a Blob URL. Metadata and direct-data results retain no managed resource. Release managed files after every consumer finishes. Outstanding URLs are also revoked on `pagehide`, including navigation into the back/forward cache; saved references cannot restore them in a new page session.

The application's [Content Security Policy](FILE-HANDLING.md#content-security-policy) must allow Blob URLs for any previews or readers that use them. Use the handle's reading methods for a consistent cross-platform API.
