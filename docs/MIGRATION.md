# Migrating from 1.3.2 to 2.0

Version 2.0 adds multiple selection, managed temporary references, browser support, and bundled TypeScript declarations. Existing single-file calls retain their names, Promise/callback forms, and `undefined` cancellation result. This guide covers **2.0.0-rc.1**.

## Update the installation

Upgrade applications to `cordova-android >=14.0.0` or `cordova-ios >=7.0.0` before installing the new plugin. Follow the [platform guide](PLATFORMS.md) for build requirements and Swift configuration; Cordova package versions and OS deployment targets are separate requirements.

From the application directory:

```sh
cordova plugin remove cordova-plugin-chooser
cordova plugin add cordova-plugin-chooser@2.0.0-rc.1
```

Review the application's manifest and lockfile changes, then rebuild each native application. Replacing JavaScript alone does not update its native plugin. Pinning RC1 explicitly avoids depending on the npm `latest` tag.

Chooser no longer depends on `cordova-plugin-add-swift-support`; remove that helper only if no other installed plugin needs it. No broad Android storage permission is required. The old `largeHeap` recommendation is not a substitute for bounded file handling.

## Existing calls

| Existing behavior | Migration consideration |
| --- | --- |
| `getFile(accept?)` | Still returns one file with bytes, data URI, name, media type, and URI |
| `getFileMetadata(accept?)` | Still omits the data payload; iOS plugin code now also avoids the full-content read |
| Success/failure callbacks | Still supported, including callback-first calls; the method also returns a Promise |
| Cancellation | Still resolves to `undefined` and invokes success with `undefined` |
| MIME filtering | Still supports comma-separated types and wildcards |
| Android single-file methods | Retain their local-provider preference |

Handle the new `size` field: unknown metadata is `null`, distinct from an empty file's `0`. Single-file handlers need no array conversion.

Data URIs now contain canonical base64 padding. Review code that compensates for missing `=` characters or compares encoded strings literally. Invalid base64 responses reject instead of silently becoming a result.

Callback exceptions are reported asynchronously without changing the picker Promise. Catch application errors inside callbacks and process each result once.

## Adopt the new methods deliberately

Use `getFiles()`, `getFilesMetadata()`, or `getFilesUri()` only when downstream code can accept a collection. Success returns a nonempty array, even for one selected file; cancellation remains `undefined`.

For large inputs, adopt URI methods with limits and a URI-aware consumer; these results omit `data` and `dataURI`. Release IDs after use. Follow the [complete pattern](FILE-HANDLING.md#consume-then-release); checking size after `getFile()` returns cannot prevent its allocation.

Android's new multiple and URI methods allow remote providers by default. URI calls can request `localOnly: true`. This matters when changing methods even though the old single-file behavior is retained.

Release IDs from every browser result and from native URI methods. Native data/metadata results have no ID. Cache URIs and Blob URLs are temporary.

## Framework and lifecycle integration

Use the [bundled TypeScript declarations](API.md#typescript) for the direct API. Ionic and other wrappers have independent method coverage and types; confirm they expose the methods and fields you use, or call the injected `chooser` global.

If your Android application handles activity recreation, account for Cordova's raw restored-result channel. It does not replay the old Promise or apply the JavaScript wrapper's decoding. See [restored Android results](PLATFORMS.md#restored-android-results).

The published 1.3.2 archive contains version `1.3.1` in `plugin.xml`. Check the installed npm version and source before inferring which code an old installation contains. The [changelog](../CHANGELOG.md) records the historical fixes.

## Check the application upgrade

Exercise selection, cancellation, failure, and repeated use on each shipped platform. Check limits and cleanup for managed references, compare binary contents, and include the providers and lifecycle transitions your workflow uses. See [interactive scenarios](VERIFICATION.md#interactive-checks).
