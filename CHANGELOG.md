# Changelog

## Unreleased

These changes are not included in npm `1.3.2`.

### Added

- Browser support, including file-input cancellation and Blob URL cleanup.
- `getFiles()` and `getFilesMetadata()` for multiple selection.
- `getFileUri()` and `getFilesUri()` for temporary native copies or browser references without transferring contents through the bridge.
- Copy options for MIME filtering, per-file bytes, total bytes, file count and Android local-provider preference.
- `releaseFile(id)` for managed-resource cleanup.
- Complete TypeScript declarations for Promise/callback forms and cancellation.
- Numeric size metadata, with `null` for unknown sizes and actual byte counts for data/copy results.

### Fixed

- Base64 decoding preserves exact bytes and canonical padding.
- Cancellation, concurrent requests, duplicate callbacks and reset handling.
- Null or incomplete provider metadata, stream cleanup and failed-batch cleanup.
- Metadata requests avoid whole-file reads in plugin code.
- Android picker restoration and iOS dismissal, orientation and document-type compatibility.
- Swift integration, platform registration and package entrypoints.

### Compatibility

- Maintained families are Cordova Android 14/15, Cordova iOS 7/8 and current browsers supporting file-input cancellation.
- Existing single-file method names, result fields, Promise/callback forms and cancellation behavior are preserved.
- URI methods use temporary storage and require ownership-aware callers. Data methods still load complete contents into memory.

### Development

- Chainman owns toolchains, frozen dependencies, updates and verification commands.
- GitHub Actions runs JavaScript, TypeScript, package and browser checks plus Android and iOS fixtures and packed-app builds.

See [NOTICE](NOTICE) and Git history for attribution and earlier changes.
