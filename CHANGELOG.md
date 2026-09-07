# Changelog

## Unreleased

Package/plugin versions remain at 1.3.2 until release preparation.

### Added

- Browser platform support, incorporating original PR #52 and correcting its bridge and resource behavior.
- Additive `getFiles()` and `getFilesMetadata()` methods; existing single-file methods remain available.
- `getFileUri()` and `getFilesUri()` for managed native cache copies / browser Blob references, with MIME hints and optional per-file byte limits.
- Opaque-ID `releaseFile()` cleanup, complete TypeScript declarations, regression fixtures and an explicit verification guide.
- Numeric size metadata (null when unknown), actual byte counts for contents/copies, remote-provider support in new Android methods and Android picker-state restoration.

### Fixed

- Exact base64 decoding and canonical padding without extra decoded bytes.
- Callback overloads, detached callback rejections, concurrent request ownership, stale completions, cancellation, reset and failed launch recovery.
- Native stream/cursor closure, background processing, null provider responses, counted copy limits, partial-batch rollback and generated cache filenames.
- Metadata-only paths no longer materialize whole-file contents in the plugin.
- iOS coordinated/security-scoped reads, dismissal handling, iPad presentation/orientation, modern type identifiers and older iWork aliases.
- Removal of obsolete Swift-support dependency, current Cordova result enums, package entrypoint/types and platform/source registration.

### Compatibility

- Support target: Cordova Android 14/15, Cordova iOS 7/8 and current browsers with file-input cancellation support. Earlier Cordova platform versions are outside this maintenance policy.
- Existing `getFile()` / `getFileMetadata()` call forms, result fields, Promise/callback support and cancellation resolving to `undefined` are retained.
- URI APIs are additive. Fork APIs that renamed existing methods/fields, removed data or made cancellation an error are not adopted wholesale.
- New copy APIs use cache storage and require release/eviction-aware callers. Legacy data APIs retain their unavoidable whole-file memory cost.

See [NOTICE](NOTICE) and Git history for source attribution and earlier releases.
