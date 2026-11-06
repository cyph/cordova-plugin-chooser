# Changelog

Publication dates are in UTC. Version links lead to npm metadata and the corresponding package archives. Related early releases are grouped below.

## 2.0.0-rc.1

The first release since 1.3.2 in 2020, this is a substantial rewrite that brings together six years of community fixes and fork improvements while modernizing platform support, file handling, and project maintenance. It retains the existing `getFile()` and `getFileMetadata()` call forms and result fields, Promise returns, optional callbacks, and cancellation resolving to `undefined`.

See the [migration guide](docs/MIGRATION.md) for upgrading and the [known iOS Files issue](docs/KNOWN-ISSUES.md) for selection and cancellation failures observed in simulator tests.

### Added

- Cordova Browser support with file selection, cancellation, and managed Blob URLs.
- `getFiles()` and `getFilesMetadata()` for multiple selection, plus `getFileUri()` and `getFilesUri()` for private native cache copies or browser references without sending file contents through the bridge.
- Copy options on URI methods for per-file bytes, aggregate bytes, file count, MIME filtering, and Android local-provider preference. Native byte limits count streamed bytes; omitted or zero limits are unlimited. URI methods provide the large-file workflow; data methods still load whole files into memory and have no configurable size limits.
- `releaseFile(id)` to release plugin-owned resources after use. Every browser result owns an ID; on native platforms, only URI results do.
- File size metadata, with `null` when a provider's size is unavailable, and complete TypeScript declarations for methods, results, options, callbacks, and cancellation.

### Changed and fixed

- Modernized support for Cordova Android 14/15 and Cordova iOS 7/8, with declared minimums of Cordova Android 14 and Cordova iOS 7. See [platform requirements](docs/PLATFORMS.md#requirements-and-coverage).
- Removed the old Swift-support helper dependency, corrected package entry points and source registration, and added an independent iOS privacy manifest bundle declaring file-timestamp API access.
- Rewrote native file processing to move provider work off the UI thread, improve Android stream and descriptor reads and iOS coordinated access, and use bounded streaming for URI copies. Metadata paths avoid whole-file reads in plugin code, though the OS or provider may still import or download a file.
- Reworked cancellation, reset, Android activity restoration, picker reopening, and request ownership. Improved stream closure, failed-batch cleanup, staged cache copies, and recovery after interrupted operations.
- Corrected binary decoding and base64 padding to preserve exact file bytes, improved callback handling, and added argument validation that rejects invalid filters, callbacks, and unknown copy-option keys before opening a picker.
- Improved MIME and document-type handling, including video and iWork formats on iOS, and updated iOS orientation and dismissal behavior.

### Verification and maintenance

- Added automated JavaScript, TypeScript, browser, native, and application-build verification in GitHub Actions.
- Introduced pinned Chainman and Nix toolchains, frozen dependency graphs, and coordinated dependency update workflows.
- Rebuilt user and contributor documentation around installation, migration, API use, file ownership, platform behavior, troubleshooting, and verification.

Thank you to @akshaydwivedi29, @alekop, @andreszs, @CaioMelo8, @cambirch, @capc0, @Ciel1412, @DavidSousa, @dpalou, @epelingu, @freed0mdev, @gitstc, @harshzalavadiya, @hc-oss, @herdwatch-apps, @ico-rst, @icomediasGmbh, @imaulenandain, @J-Gann, @MaximBelov, @Meeco, @moodlemobile, @NityaSantosh26, @redarea-snc, @tgptom, @uberfusion007, @vishwanath1004, @vuhuuthang15, @wideLandscape, @WodifyLLC, @zbarbuto, and Constantino Gomes for the pull requests, fork improvements, and ideas brought together in this release.

## [1.3.2](https://registry.npmjs.org/cordova-plugin-chooser/1.3.2) — 2020-07-26

Fixed Android data selection by retaining `includeData` in plugin state. The published npm package is 1.3.2, though its `plugin.xml` reports 1.3.1.

## [1.3.1](https://registry.npmjs.org/cordova-plugin-chooser/1.3.1) — 2020-05-01

Fixed iOS compilation, argument handling, Core Foundation conversions, and document-picker delegate signatures after the metadata API addition.

## [1.3.0](https://registry.npmjs.org/cordova-plugin-chooser/1.3.0) — 2020-04-30

Added `getFileMetadata()` for a file name, media type, and URI without sending its data to JavaScript. The native `includeData` flag was introduced with it.

## [1.2.7](https://registry.npmjs.org/cordova-plugin-chooser/1.2.7) — 2020-04-04

Changed the default iOS document type from `public.data` to `public.item`.

## [1.2.6](https://registry.npmjs.org/cordova-plugin-chooser/1.2.6) — 2020-02-25

Added callback-first calls such as `getFile(success, failure)` and lowercased MIME filters. Clarified the XML namespace for the Android large-heap setting documented at the time.

## [1.2.5](https://registry.npmjs.org/cordova-plugin-chooser/1.2.5) — 2019-01-24

Added optional success and failure callbacks alongside the Promise. Android unrestricted selection no longer supplied an extra MIME list, and single-file selection explicitly disabled multiple selection.

## [1.2.4](https://registry.npmjs.org/cordova-plugin-chooser/1.2.4) — 2018-10-22

Made Android exception handling compatible with Java 6.

## [1.2.3](https://registry.npmjs.org/cordova-plugin-chooser/1.2.3) — 2018-08-21

Documented Android heap configuration for large files without changing runtime behavior. See [file handling](docs/FILE-HANDLING.md) for the 2.0 URI methods.

## [1.2.2](https://registry.npmjs.org/cordova-plugin-chooser/1.2.2) — 2018-08-10

Fixed Android MIME-list filtering using `Intent.EXTRA_MIME_TYPES` and a generic base type.

## [1.2.1](https://registry.npmjs.org/cordova-plugin-chooser/1.2.1) — 2018-08-02

Corrected the version in `plugin.xml` without changing runtime behavior.

## [1.2.0](https://registry.npmjs.org/cordova-plugin-chooser/1.2.0) — 2018-07-31

Added a base64 `dataURI` field alongside the `Uint8Array` data result.

## 1.1.2–1.1.20 — 2018-07-31

Improved Swift MIME-list parsing, type inference, Core Foundation bridging, and wildcard handling.

[1.1.2](https://registry.npmjs.org/cordova-plugin-chooser/1.1.2), [1.1.3](https://registry.npmjs.org/cordova-plugin-chooser/1.1.3), [1.1.4](https://registry.npmjs.org/cordova-plugin-chooser/1.1.4), [1.1.5](https://registry.npmjs.org/cordova-plugin-chooser/1.1.5), [1.1.6](https://registry.npmjs.org/cordova-plugin-chooser/1.1.6), [1.1.7](https://registry.npmjs.org/cordova-plugin-chooser/1.1.7),
[1.1.8](https://registry.npmjs.org/cordova-plugin-chooser/1.1.8), [1.1.9](https://registry.npmjs.org/cordova-plugin-chooser/1.1.9), [1.1.10](https://registry.npmjs.org/cordova-plugin-chooser/1.1.10), [1.1.11](https://registry.npmjs.org/cordova-plugin-chooser/1.1.11), [1.1.12](https://registry.npmjs.org/cordova-plugin-chooser/1.1.12), [1.1.13](https://registry.npmjs.org/cordova-plugin-chooser/1.1.13),
[1.1.14](https://registry.npmjs.org/cordova-plugin-chooser/1.1.14), [1.1.15](https://registry.npmjs.org/cordova-plugin-chooser/1.1.15), [1.1.16](https://registry.npmjs.org/cordova-plugin-chooser/1.1.16), [1.1.17](https://registry.npmjs.org/cordova-plugin-chooser/1.1.17), [1.1.18](https://registry.npmjs.org/cordova-plugin-chooser/1.1.18), [1.1.19](https://registry.npmjs.org/cordova-plugin-chooser/1.1.19),
[1.1.20](https://registry.npmjs.org/cordova-plugin-chooser/1.1.20).

## [1.1.1](https://registry.npmjs.org/cordova-plugin-chooser/1.1.1) — 2018-07-31

Added comma-separated MIME filters, whitespace normalization, and iOS wildcard mappings for audio, fonts, images, text, and video.

## [1.1.0](https://registry.npmjs.org/cordova-plugin-chooser/1.1.0) — 2018-07-27

Changed cancellation from rejection with `{canceled: true}` to resolution with `undefined`. Failures reject directly instead of using an `{error: ...}` wrapper.

## 1.0.1–1.0.38 — 2018-07-26 to 2018-07-27

These early updates fixed native registration, bridge arguments, iOS document-type conversion, coordinated reads, and result serialization. Version 1.0.38 removed JavaScript diagnostic alerts and restored Promise rejection.

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

Initial Android and iOS package with Promise-based `getFile()`, MIME filtering, and file data, name, media type, and URI results.

## Historical sources

The [npm package record](https://registry.npmjs.org/cordova-plugin-chooser) contains publication timestamps and package archives. See the [Git history](https://github.com/cyph/cordova-plugin-chooser/commits/master/) for source history and contributor attribution.
