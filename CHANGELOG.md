# Changelog

Dates below are npm publication dates in UTC. Historical links lead to version metadata and its published source archive. Early releases with closely related implementation fixes are grouped; individual archives remain linked for reference.

## Unreleased

- Reject invalid filters, callbacks, and unknown copy-option keys before opening a picker, preventing silently ignored wrapper options or misspelled limits.
- Clarify fork-wrapper migration, CSV decoding, provider filtering, and large-file workflows.

## 2.0.0-rc.1

First release candidate for 2.0.0. Changes are relative to 1.3.2; see the [migration guide](docs/MIGRATION.md).

### Added

- Cordova Browser support with file-input cancellation and managed Blob URLs.
- `getFiles()` and `getFilesMetadata()` for multiple selection.
- `getFileUri()` and `getFilesUri()` for native cache copies or browser references without transferring contents through the bridge.
- `releaseFile(id)` for plugin-owned resources, plus copy options for per-file bytes, total bytes, file count, MIME filtering, and Android local-provider preference.
- Size metadata, including `null` when unavailable, and bundled TypeScript declarations covering all public methods, options, callbacks, and cancellation.
- An independent iOS privacy resource bundle declaring file-timestamp API access.

### Changed and fixed

- Requires Cordova Android 14 or later, or Cordova iOS 7 or later, on the corresponding native platform. Maintained families are Android 14/15 and iOS 7/8; see [platform requirements](docs/PLATFORMS.md#requirements-and-coverage).
- Removed the separate Swift-support dependency and corrected package entry points and source registration.
- Preserved existing single-file calls and cancellation behavior while correcting binary decoding, canonical base64 padding, and application callback error handling.
- Metadata paths avoid whole-file reads in plugin code. Native managed copies use bounded streaming, generated cache names, staged batches, and interrupted-operation recovery.
- Improved cancellation, concurrent-request handling, reset ownership, provider metadata handling, stream closure, and failed-batch cleanup.
- Updated Android activity restoration and iOS document types, dismissal, orientation, and main-thread ownership.

## [1.3.2](https://registry.npmjs.org/cordova-plugin-chooser/1.3.2) — 2020-07-26

Fixed Android data selection by retaining `includeData` in plugin state instead of expecting the result intent to return the request extra. The npm package is version 1.3.2, but its `plugin.xml` still reports 1.3.1.

## [1.3.1](https://registry.npmjs.org/cordova-plugin-chooser/1.3.1) — 2020-05-01

Fixed iOS compilation and document-picker delegate signatures after the metadata API addition, including argument retrieval and Core Foundation string conversions.

## [1.3.0](https://registry.npmjs.org/cordova-plugin-chooser/1.3.0) — 2020-04-30

Added `getFileMetadata()` to return a file's name, media type, and URI without sending its data payload to JavaScript. This introduced the native `includeData` flag; the subsequent 1.3.1 and 1.3.2 releases corrected platform integration issues.

## [1.2.7](https://registry.npmjs.org/cordova-plugin-chooser/1.2.7) — 2020-04-04

Broadened the iOS default document type from `public.data` to `public.item`.

## [1.2.6](https://registry.npmjs.org/cordova-plugin-chooser/1.2.6) — 2020-02-25

Added callback-first calls such as `getFile(success, failure)` and lowercased MIME filters for integration compatibility. Clarified the Android XML namespace used by the then-documented large-heap setting.

## [1.2.5](https://registry.npmjs.org/cordova-plugin-chooser/1.2.5) — 2019-01-24

Added optional success/failure callbacks while retaining the Promise result. Android no longer supplied an extra MIME list for unrestricted selection and explicitly disabled multiple selection for the single-file API.

## [1.2.4](https://registry.npmjs.org/cordova-plugin-chooser/1.2.4) — 2018-10-22

Replaced Android's multi-catch expression for Java 6 compatibility.

## [1.2.3](https://registry.npmjs.org/cordova-plugin-chooser/1.2.3) — 2018-08-21

Documented Android large-file heap configuration; runtime behavior was unchanged. For 2.0 applications, prefer [bounded URI methods](docs/FILE-HANDLING.md) for large files.

## [1.2.2](https://registry.npmjs.org/cordova-plugin-chooser/1.2.2) — 2018-08-10

Corrected Android MIME-list filtering with `Intent.EXTRA_MIME_TYPES` and a generic base type.

## [1.2.1](https://registry.npmjs.org/cordova-plugin-chooser/1.2.1) — 2018-08-02

Aligned the version in `plugin.xml`; runtime behavior was unchanged.

## [1.2.0](https://registry.npmjs.org/cordova-plugin-chooser/1.2.0) — 2018-07-31

Added the base64 `dataURI` field alongside the existing `Uint8Array` data result.

## 1.1.2–1.1.20 — 2018-07-31

Refined Swift MIME-list parsing, type inference, Core Foundation bridging, and wildcard handling after MIME-list support was introduced. These releases did not add another JavaScript method or result field.

[1.1.2](https://registry.npmjs.org/cordova-plugin-chooser/1.1.2), [1.1.3](https://registry.npmjs.org/cordova-plugin-chooser/1.1.3), [1.1.4](https://registry.npmjs.org/cordova-plugin-chooser/1.1.4), [1.1.5](https://registry.npmjs.org/cordova-plugin-chooser/1.1.5), [1.1.6](https://registry.npmjs.org/cordova-plugin-chooser/1.1.6), [1.1.7](https://registry.npmjs.org/cordova-plugin-chooser/1.1.7),
[1.1.8](https://registry.npmjs.org/cordova-plugin-chooser/1.1.8), [1.1.9](https://registry.npmjs.org/cordova-plugin-chooser/1.1.9), [1.1.10](https://registry.npmjs.org/cordova-plugin-chooser/1.1.10), [1.1.11](https://registry.npmjs.org/cordova-plugin-chooser/1.1.11), [1.1.12](https://registry.npmjs.org/cordova-plugin-chooser/1.1.12), [1.1.13](https://registry.npmjs.org/cordova-plugin-chooser/1.1.13),
[1.1.14](https://registry.npmjs.org/cordova-plugin-chooser/1.1.14), [1.1.15](https://registry.npmjs.org/cordova-plugin-chooser/1.1.15), [1.1.16](https://registry.npmjs.org/cordova-plugin-chooser/1.1.16), [1.1.17](https://registry.npmjs.org/cordova-plugin-chooser/1.1.17), [1.1.18](https://registry.npmjs.org/cordova-plugin-chooser/1.1.18), [1.1.19](https://registry.npmjs.org/cordova-plugin-chooser/1.1.19),
[1.1.20](https://registry.npmjs.org/cordova-plugin-chooser/1.1.20).

## [1.1.1](https://registry.npmjs.org/cordova-plugin-chooser/1.1.1) — 2018-07-31

Introduced comma-separated MIME filters, whitespace normalization, and iOS wildcard mappings for audio, fonts, images, text, and video. Later releases refined the Swift implementation and Android MIME-list handling.

## [1.1.0](https://registry.npmjs.org/cordova-plugin-chooser/1.1.0) — 2018-07-27

Changed cancellation from rejection with `{canceled: true}` to successful resolution with `undefined`. Failures now reject directly instead of being wrapped in an `{error: ...}` object.

## 1.0.1–1.0.38 — 2018-07-26 to 2018-07-27

This initial correction series refined native registration, bridge arguments, iOS document-type conversion, coordinated reads, and result serialization. Version 1.0.38 removed JavaScript diagnostic alerts and restored Promise rejection. The series established the single-file implementation subsequently used by 1.1.0.

Published on July 26:

[1.0.1](https://registry.npmjs.org/cordova-plugin-chooser/1.0.1), [1.0.2](https://registry.npmjs.org/cordova-plugin-chooser/1.0.2), [1.0.3](https://registry.npmjs.org/cordova-plugin-chooser/1.0.3).

Published on July 27:

[1.0.4](https://registry.npmjs.org/cordova-plugin-chooser/1.0.4), [1.0.5](https://registry.npmjs.org/cordova-plugin-chooser/1.0.5), [1.0.6](https://registry.npmjs.org/cordova-plugin-chooser/1.0.6), [1.0.7](https://registry.npmjs.org/cordova-plugin-chooser/1.0.7), [1.0.8](https://registry.npmjs.org/cordova-plugin-chooser/1.0.8), [1.0.9](https://registry.npmjs.org/cordova-plugin-chooser/1.0.9),
[1.0.10](https://registry.npmjs.org/cordova-plugin-chooser/1.0.10), [1.0.11](https://registry.npmjs.org/cordova-plugin-chooser/1.0.11), [1.0.12](https://registry.npmjs.org/cordova-plugin-chooser/1.0.12), [1.0.13](https://registry.npmjs.org/cordova-plugin-chooser/1.0.13), [1.0.14](https://registry.npmjs.org/cordova-plugin-chooser/1.0.14), [1.0.15](https://registry.npmjs.org/cordova-plugin-chooser/1.0.15),
[1.0.16](https://registry.npmjs.org/cordova-plugin-chooser/1.0.16), [1.0.17](https://registry.npmjs.org/cordova-plugin-chooser/1.0.17), [1.0.18](https://registry.npmjs.org/cordova-plugin-chooser/1.0.18), [1.0.19](https://registry.npmjs.org/cordova-plugin-chooser/1.0.19), [1.0.20](https://registry.npmjs.org/cordova-plugin-chooser/1.0.20), [1.0.21](https://registry.npmjs.org/cordova-plugin-chooser/1.0.21),
[1.0.22](https://registry.npmjs.org/cordova-plugin-chooser/1.0.22), [1.0.23](https://registry.npmjs.org/cordova-plugin-chooser/1.0.23), [1.0.24](https://registry.npmjs.org/cordova-plugin-chooser/1.0.24), [1.0.25](https://registry.npmjs.org/cordova-plugin-chooser/1.0.25), [1.0.26](https://registry.npmjs.org/cordova-plugin-chooser/1.0.26), [1.0.27](https://registry.npmjs.org/cordova-plugin-chooser/1.0.27),
[1.0.28](https://registry.npmjs.org/cordova-plugin-chooser/1.0.28), [1.0.30](https://registry.npmjs.org/cordova-plugin-chooser/1.0.30), [1.0.31](https://registry.npmjs.org/cordova-plugin-chooser/1.0.31), [1.0.32](https://registry.npmjs.org/cordova-plugin-chooser/1.0.32), [1.0.33](https://registry.npmjs.org/cordova-plugin-chooser/1.0.33), [1.0.34](https://registry.npmjs.org/cordova-plugin-chooser/1.0.34),
[1.0.35](https://registry.npmjs.org/cordova-plugin-chooser/1.0.35), [1.0.36](https://registry.npmjs.org/cordova-plugin-chooser/1.0.36), [1.0.37](https://registry.npmjs.org/cordova-plugin-chooser/1.0.37), [1.0.38](https://registry.npmjs.org/cordova-plugin-chooser/1.0.38).

Version 1.0.29 is absent from the npm publication record.

## [1.0.0](https://registry.npmjs.org/cordova-plugin-chooser/1.0.0) — 2018-07-26

Initial package with Android and iOS implementations, a Promise-based `getFile()` API, MIME filtering, and file data, name, media type, and URI results.

## Historical sources

The [npm package record](https://registry.npmjs.org/cordova-plugin-chooser) supplies publication timestamps and checksummed archives. Entries describe the shipped packages: some early archives differ despite sharing a `gitHead`. [Git history](https://github.com/cyph/cordova-plugin-chooser/commits/master/) provides additional context and contributor attribution.
