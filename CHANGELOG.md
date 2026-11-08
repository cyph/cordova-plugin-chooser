# Changelog

Publication dates are in UTC. Version links lead to npm metadata and the corresponding package archives. Related early releases are grouped below.

## [2.0.0-rc.2](https://registry.npmjs.org/cordova-plugin-chooser/2.0.0-rc.2)

RC2 makes managed files the default, adds photo-library selection, and gives applications bounded reading and shared resource ownership. Complete-data reads remain available in explicit formats. This is a breaking API change; see the [migration guide](docs/MIGRATION.md).

### API changes

- `getFile` and `getFiles` return managed handles with metadata, a temporary URI, and whole-file, `readRange`, and streaming readers. They replace the RC1 `getFileUri` and `getFilesUri` methods.
- Added `withFile` and `withFiles` for scoped use and cleanup, `restoreFile` for saved references, and `releaseFiles` for batch cleanup. Aliases share ownership; release stops unfinished plugin streams and waits for started reads before removing the resource. Batch release validates every ID, including missing array entries, before starting.
- Added `getFileData`, `getFilesData`, and managed `getData` with explicit `bytes`, `text`, `blob`, `arrayBuffer`, `dataURI`, and `bytesAndDataURI` formats. Each result includes metadata, format, and actual size; managed `blob()` and `arrayBuffer()` continue to return raw values. The combined format preserves the useful RC1 pair with one content read. Direct-data and metadata results have no retained managed resource or release obligation.
- Picker calls now take options objects and return Promises without callback overloads. Cancellation rejects with `CancellationError`, including cancellation caused by an operation's `AbortSignal`; that signal's reason is preserved as the cancellation cause, including through cleanup failures. Structured error codes replace parsing diagnostic text; `CleanupError` preserves a successful consumer result or original failure alongside cleanup failures.
- Text reads and text-format data calls accept top-level `encoding` and `fatal` options; binary data formats reject them.
- Managed and direct-data selection require positive byte budgets or explicit `null` for unlimited. Plural calls require an aggregate budget, and whole-file readers require a separate `maxBytes` budget. Omitted and zero byte limits are no longer unlimited.
- Document filters accept MIME strings or arrays. Android document selection allows remote providers by default, with the optional `preferLocal` provider hint (default `false`). Metadata and direct-data results expose optional borrowed `sourceUri` rather than a managed `uri`.

### Platforms and maintenance

- Added image/video library selection through iOS PHPicker and Android Photo Picker with a document fallback. Browser photo selection uses a filtered file input; its UI is chosen by the browser and OS. Photo selection does not require broad library permissions, and metadata inspection does not load a complete representation just to discover its size.
- Raised the iOS minimum to 15 and added deployment-target validation during Cordova preparation. Retained Cordova Android 14/15 and iOS 7/8 support. TypeScript declarations now require 5.7 or later.
- Required iOS simulator coverage exercises controlled native picker contracts across both Cordova iOS families and device classes. Real picker and provider UI cases remain in the manual iOS picker investigation workflow; the observed [Files selection issue](docs/KNOWN-ISSUES.md) remains unresolved. See [verification](docs/VERIFICATION.md#simulator-and-framework-integration) for coverage and limits.

## [2.0.0-rc.1](https://registry.npmjs.org/cordova-plugin-chooser/2.0.0-rc.1) — 2026-11-06

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

Thank you to everyone whose work informed this release. Some changes were merged directly; others were adapted to fit the existing API and the new file-handling implementation:

- [@andreszs](https://github.com/andreszs) contributed [browser support](https://github.com/cyph/cordova-plugin-chooser/pull/52).
- [@alekop](https://github.com/alekop) contributed [cross-platform multiple-selection changes](https://github.com/hc-oss/cordova-plugin-simple-file-chooser/pull/1), and [@harshzalavadiya](https://github.com/harshzalavadiya) contributed an [Android implementation](https://github.com/hc-oss/cordova-plugin-simple-file-chooser/commit/43add24d853570a6c1fc91fa56b5aacd0617b833) in the [@hc-oss](https://github.com/hc-oss) fork. [@cambirch](https://github.com/cambirch) contributed another [multiple-selection implementation](https://github.com/cambirch/cordova-plugin-chooser-ex/commit/eb43a2dab5c3c089a90fdabad6742536b23a4937) in chooser-ex.
- [@capc0](https://github.com/capc0) and [@vishwanath1004](https://github.com/vishwanath1004) contributed Android out-of-memory handling in [#41](https://github.com/cyph/cordova-plugin-chooser/pull/41) and [#50](https://github.com/cyph/cordova-plugin-chooser/pull/50). [@uberfusion007](https://github.com/uberfusion007) contributed the [iOS dismissal callback](https://github.com/cyph/cordova-plugin-chooser/pull/43).
- [@Ciel1412](https://github.com/Ciel1412) contributed a [Swift type fix](https://github.com/cyph/cordova-plugin-chooser/pull/32), and [@J-Gann](https://github.com/J-Gann) aligned the [plugin version](https://github.com/cyph/cordova-plugin-chooser/pull/37). [@freed0mdev](https://github.com/freed0mdev) (credited as yokodima in the source commit) contributed the [package homepage](https://github.com/cyph/cordova-plugin-chooser/pull/20).
- [@dpalou](https://github.com/dpalou), in the [@moodlemobile](https://github.com/moodlemobile) fork, removed the [obsolete Swift support dependency](https://github.com/moodlemobile/cordova-plugin-chooser/commit/8baeee2ca1f7caca96ecf5a5c251969c69034446) and updated [Cordova iOS status names](https://github.com/moodlemobile/cordova-plugin-chooser/commit/dc14bfc9f09b903dac2304d6395e475746dc9ae6).
- [@MaximBelov](https://github.com/MaximBelov) contributed [cache-copy and size-limit concepts](https://github.com/MaximBelov/cordova-plugin-chooser/commit/b4b63969330b0491c3a69afc79e92ef998595501), and an [iOS orientation fix](https://github.com/herdwatch-apps/cordova-plugin-chooser/commit/c690585dfa6ef89d0f8a3bb95970d7643b842c6f) in the [@herdwatch-apps](https://github.com/herdwatch-apps) fork.
- [@zbarbuto](https://github.com/zbarbuto), in the [@Meeco](https://github.com/Meeco) fork, contributed [explicit resource release](https://github.com/Meeco/cordova-plugin-chooser/commit/fd1ecb3c6c1cc145533c7d3ff07b442c66a44edd) and the [video type correction](https://github.com/Meeco/cordova-plugin-chooser/commit/fdbbefbc23000c5e119de28b48187ee478c9d1a5). The [@NityaSantosh26](https://github.com/NityaSantosh26) fork's [temporary-file handling](https://github.com/NityaSantosh26/cordova-plugin-simple-file-chooser/commit/cec7de2639de4c0eb3536b8113dc1b9c4510bcee) also informed file-lifetime handling.
- Constantino Gomes contributed [file-size reporting](https://github.com/WodifyLLC/cordova-plugin-chooser/commit/11dd9a6d97d3c167717b701d94e8828903b9b880) and [unlimited-size handling](https://github.com/WodifyLLC/cordova-plugin-chooser/commit/b40f31549783c80b20ad309ae5229e09dcd23f91) in the [@WodifyLLC](https://github.com/WodifyLLC) fork. [@epelingu](https://github.com/epelingu) and [@akshaydwivedi29](https://github.com/akshaydwivedi29) contributed further [provider-size](https://github.com/epelingu/cordova-plugin-chooser/commit/facedb6e64702dd5d993496f0ce22949272ba712) and [result-size](https://github.com/akshaydwivedi29/cordova-plugin-chooser/commit/431d75f0cfb01520f477a3eb5b31f6649c26a8ac) improvements.
- The [@tgptom](https://github.com/tgptom) fork's [modernization](https://github.com/tgptom/cordova-plugin-chooser/commit/14c516f5ef449eab3504546698ce7eb5693e8315) informed Android restoration and null handling and iOS type identifiers. The [@redarea-snc](https://github.com/redarea-snc) fork also supplied an earlier [activity-restoration approach](https://github.com/redarea-snc/cordova-plugin-chooser/commit/859cd97ae14f5b8f7758a27c95f0613ec00c5a49).
- [@gitstc](https://github.com/gitstc) contributed [input-stream cleanup](https://github.com/gitstc/cordova-plugin-chooser/commit/3b8560ff96f7c6079a12ad0398ebc7e9e4f18ddb). [@ico-rst](https://github.com/ico-rst), in the [@icomediasGmbh](https://github.com/icomediasGmbh) fork, contributed [remote-provider selection](https://github.com/icomediasGmbh/cordova-plugin-chooser/commit/34e0282d8e3b5915503e505954bc1d28fcda6c40); [@imaulenandain](https://github.com/imaulenandain)'s [large-file work](https://github.com/imaulenandain/cordova-plugin-chooser/commit/316ad217caea6d629011cd81098e94ee084ee1d1) informed background processing.
- [@CaioMelo8](https://github.com/CaioMelo8) contributed a [base64 padding fix](https://github.com/CaioMelo8/cordova-plugin-chooser/commit/4e7f11617ed0d1c1aa71a3e1517997d884bb65f0), and [@DavidSousa](https://github.com/DavidSousa) contributed [iWork type aliases](https://github.com/DavidSousa/cordova-plugin-chooser/commit/92c4b910d932313d45ab6678a4d6b1e4656ae0aa).
- Thang Vu's [TypeScript declarations](https://github.com/vuhuuthang15/cordova-plugin-chooser/commit/7dedccf075c28edc00dbc2cf77c3189217aac8a3) in the [@vuhuuthang15](https://github.com/vuhuuthang15) fork and [@wideLandscape](https://github.com/wideLandscape)'s [declarations](https://github.com/wideLandscape/cordova-plugin-chooser/commit/bca8ff73d3b9d26891e163059ffefcec20beffb2) informed the bundled types.

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
