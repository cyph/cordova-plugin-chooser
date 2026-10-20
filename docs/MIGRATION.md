# Migrating from 1.3.2 to 2.0

## Platform and build requirements

The maintained families are Cordova Android 14/15 and Cordova iOS 7/8. Upgrade older Cordova platforms before installing this candidate. See [compatibility](../README.md#compatibility) for OS requirements and the distinction between Cordova's minimum OS versions and the deployment target qualified with the selected Xcode.

Configure Swift 5 mode and an iOS 15.0 deployment target for the current Apple build lane:

```xml
<platform name="ios">
  <preference name="SwiftVersion" value="5.0" />
  <preference name="deployment-target" value="15.0" />
</platform>
```

No separate Swift-support plugin or blanket Android storage permission is required. The plugin supplies its own iOS privacy bundle; review your application's privacy declarations separately.

## Existing calls

`getFile()` and `getFileMetadata()` retain their MIME-filter argument, Promise/callback forms, existing result fields and cancellation resolving to `undefined`. Existing single-file calls do not need to become array-based calls. Results add numeric `size` metadata, with `null` when a metadata query cannot determine the size.

Data methods still load complete contents into memory. For large or uncertain file sizes, consider the new URI methods and set byte/count limits appropriate to your application.

## New selection and ownership options

`getFiles()` and `getFilesMetadata()` return arrays on success. Like single-file methods, they resolve to `undefined` on cancellation.

`getFileUri()` and `getFilesUri()` return temporary managed references. Native platforms copy into app-private cache; browsers create Blob URLs. Keep the returned opaque `id` and call `releaseFile(id)` after every consumer finishes. Every browser result has an ID, including results from data and metadata methods. Do not treat temporary URIs as durable storage or pass arbitrary filesystem paths to `releaseFile`.

See the [API reference](API.md) for complete signatures and [file handling](FILE-HANDLING.md) for cleanup examples, storage costs and provider limitations.
