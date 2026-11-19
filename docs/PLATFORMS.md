# Platform guide

Chooser delegates selection to the operating system or browser. Your app controls the requested source and filters, while the provider controls its interface, available files, and access to them. This guide describes RC2.

## Requirements and coverage

| Environment | Supported project versions and requirements |
| --- | --- |
| Cordova Android | Android platform 14.x or 15.x, Android 7.0 / API 24 or newer |
| Cordova iOS | iOS platform 7.x or 8.x, deployment target iOS 15 or newer. Project tests use Swift 5 language mode |
| Cordova Browser | Platform 7.x and the browser APIs listed below |
| Capacitor Android | Capacitor 8.x, Android 7.0 / API 24 or newer |
| Capacitor iOS | Capacitor 8.x, iOS 15 or newer |
| Capacitor Web | Capacitor 8.x and the browser APIs listed below |

The native Cordova engine minimums declared by the plugin are Android 14 and iOS 7. Follow Cordova's [Android](https://cordova.apache.org/docs/en/latest/guide/platforms/android/) and [iOS](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) setup instructions for their toolchains. Your host framework or other plugins can require higher native targets.

The standard Capacitor 8 templates meet these platform minimums. The Capacitor tests exercise both native bridges with controlled picker results and the web picker in three browser engines. See [verification](VERIFICATION.md) for the test cases.

## Android

<a id="selection-and-providers"></a>

### Documents and providers

The document picker requests openable files with temporary read access. No broad storage permission or persistent document grant is required. Remote providers are available by default and may require network access, authentication, downloads, or conversion. `preferLocal: true` is a request to the provider, not a guarantee that all returned data is local.

A provider may return one item from a multiple-selection request. Multiple methods still resolve to an array. `sourceUri`, when supplied, is borrowed from the provider. A managed `uri` instead points to Chooser's private copy.

### Photos and videos

`source: 'photos'` requests Android's Photo Picker. Where it is unavailable, a supported document picker acts as a fallback. The fallback can look different and may not enforce a requested count in its UI. Chooser checks the returned count. Photo selection does not need broad media-library permission and does not capture new media.

### Lifecycle

An Android activity can be recreated while its picker is open. A destroyed WebView cannot keep its original Promise or JavaScript upload alive. Cancellation or reset can also leave the picker reserved until its activity result returns, during which a new request may report `BUSY`.

### Restored Android results

In Capacitor, an activity recreation during a pending picker discards that selection. With `@capacitor/app`, listen for `appRestoredResult` from plugin ID `Chooser` and method `pick` with error code `READ_INTERRUPTED`. Offer a new selection once the old result returns. Previously delivered managed references can still be restored while their cache files survive.

```ts
import { App } from '@capacitor/app';

void App.addListener('appRestoredResult', event => {
  if (event.pluginId === 'Chooser' && event.methodName === 'pick' &&
      event.error && 'code' in event.error && event.error.code === 'READ_INTERRUPTED') {
    console.info('The previous selection ended. You can choose a file again.');
  }
});
```

A Cordova application handling activity recreation can inspect `resume.pendingResult`. Check `pluginServiceName === 'Chooser'` and `pluginStatus`. This is a raw native envelope, not an already constructed public result.

For a managed-copy payload, parse the reference and use `restoreFile` before using it. If discarding the payload, release the managed ID. Metadata has no managed resource. Direct-data operations can expose a temporary source-reader payload, not a `FileData` result. Release any returned source IDs and ask for a new selection. `RESULT_CANCELED` denotes cancellation. Record enough application state to identify the interrupted operation, but do not assume recovery is always possible or that an interrupted upload resumed.

## iOS

### Build configuration

For a Cordova app, set the deployment target explicitly in `config.xml` before installing or preparing the plugin.

```xml
<platform name="ios">
  <preference name="deployment-target" value="15.0" />
</platform>
```

Keep a higher existing deployment target. Chooser's Cordova prepare hook checks this target and rejects a missing target or one below 15. It does not check Swift settings. The project is tested in Swift 5 language mode, which the host may already select. If needed, set `<preference name="SwiftVersion" value="5.0" />` in the iOS platform configuration. Cordova iOS supplies Swift integration, so this plugin no longer needs `cordova-plugin-add-swift-support`.

The iOS minimum comes from the Photos picker API used by RC2.

<a id="document-access-and-presentation"></a>

### Documents and presentation

The Files picker selects regular documents, not directories or document packages. Present it from a visible app view after other modal transitions finish. The picker follows supported app orientations and is anchored for iPad presentation.

For metadata selection, UIKit receives an import request. The plugin does not read all the contents for metadata, but the OS or provider may copy or download the entire document. This work can take time and disk space outside Chooser's byte limits. The resulting borrowed `sourceUri` may point to an iOS temporary import. It is not a managed ID or persistent bookmark. See Apple's [document picker documentation](https://developer.apple.com/documentation/uikit/uidocumentpickerdelegate/documentpicker(_:didpickdocumentsat:)). Managed-copy and direct-data document selection open in place and use coordinated, security-scoped access as needed.

Files can remain open without delivering a result in some simulator runs. See [known issues](KNOWN-ISSUES.md#intermittent-ios-files-selection) for symptoms, practical recovery, and the limits of that evidence.

### Photos and videos

`source: 'photos'` opens `PHPickerViewController`. `mediaTypes` can narrow selection to images or videos. Access is limited to the selected items, so broad photo-library permission is not required. The plugin does not provide capture or editing.

The system is asked for the current representation. It may still supply converted data, so the returned bytes are not guaranteed to be the original encoding. Photo metadata can omit an exact size. A managed selection is appropriate when the app needs contents and the actual byte count.

For direct-data Photos selection, the temporary provider representation is staged in private cache before it expires. Chooser removes its copy after reading it, and the app does not release the returned data. Allow storage for that copy as well as any provider-owned files.

### Types and privacy

Document filters map MIME types to system type identifiers. Unknown mappings can broaden the selection. Check actual contents in the consuming app. The plugin ships a separate `ChooserPrivacy.bundle/PrivacyInfo.xcprivacy` declaring file-timestamp access with reason `C617.1`, no tracking, and no collected-data types. An app must account for its own behavior and other dependencies.

## Browser

The Cordova Browser and Capacitor Web pickers need Promises, typed arrays, `File` and `Blob` APIs including `slice()` and `arrayBuffer()`, Blob URLs, Web Crypto, `AbortController`, `ReadableStream`, `TextDecoder`, and the file-input `cancel` event. If cancellation events are unavailable, dismissal can remain pending until the app aborts the operation.

Call the picker directly from a user gesture, before awaiting a timer or network operation. Cordova Browser also needs `deviceready`. For `source: 'photos'`, a filtered file input is used and the browser and OS determine the interface. A dedicated library UI is not guaranteed. `preferLocal` has no effect, and browser results do not reveal an original filesystem path.

Managed files hold a `File` and Blob URL until release or `pagehide`, including back/forward-cache navigation. Metadata and direct data do not hold a managed resource in RC2. Saved references cannot recreate browser resources after their page registry is gone. Configure [CSP](FILE-HANDLING.md#content-security-policy) for Blob URL consumers.
