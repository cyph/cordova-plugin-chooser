# Known limitations in 2.0.0-rc.1

RC1 is intended for application integration testing. The changes in the [changelog](../CHANGELOG.md#200-rc1) have automated coverage, but complete iOS UI qualification and real cloud-provider testing remain pending. Validate the methods, devices, and providers your application uses before deploying it to users.

## Intermittent iOS Files selection

Automated tests on recent iPhone and iPad simulators have intermittently left Files open after selecting a local CSV or PDF. In captured failures, File Provider could not resolve the selected document's URL and reported error `-1005` (file does not exist), despite the source file's bytes and sampled filesystem identifiers remaining unchanged. The picker did not deliver its selection callback, so the request remained pending. Other runs have also stalled during native picker cancellation.

The selection failure also occurs in a plain UIKit application without Cordova or Chooser. The same document can succeed in a later selection. These observations do not yet distinguish a simulator/provider defect from an interaction with the test setup. Independent physical-device reproduction is still needed; the failures do not establish an older-device compatibility problem.

If the picker responds, use its Cancel control and wait for cancellation before trying again. If it remains unresponsive, restarting the application may be necessary. Preserve unrelated application work and ask the user to select again after restart. Repeated picker calls while the request is pending reject with `BUSY`; the public API has no cancel or timeout operation. An application timeout does not cancel the native request and must not be treated as confirmed picker cancellation.

There is no verified plugin-side workaround. Include the OS, device or simulator, provider/location, method/options, and a small nonprivate reproduction in an [issue report](TROUBLESHOOTING.md#report-a-reproducible-issue).

## Provider listings and MIME filters

Providers control which documents appear and how they classify them. Filters guide selection; they do not validate the selected contents. CSV/JSON filtering in Drive and other provider-specific listings is not verified universally. For a disabled file, an explicit `'*/*'` request can help diagnose a type mismatch; validate the resulting contents in the consuming application. See [CSV, JSON, and provider filters](FILE-HANDLING.md#csv-json-and-provider-filters).

Historical reports of empty iOS listings, missing local files, and empty Android PDF contents do not include enough current reproduction detail to establish their cause or claim a universal fix. Reports [#12](https://github.com/cyph/cordova-plugin-chooser/issues/12), [#17](https://github.com/cyph/cordova-plugin-chooser/issues/17), [#36](https://github.com/cyph/cordova-plugin-chooser/issues/36), and [#40](https://github.com/cyph/cordova-plugin-chooser/issues/40) remain relevant when reproducing those symptoms. Files/document providers and the Photos library expose different locations; Chooser does not add a Photos-library picker.

## Large files and temporary references

Upgrading alone does not make `getFile()` or `getFiles()` safe for arbitrarily large inputs: they still materialize complete contents and can exhaust memory. Adopt the URI methods with explicit limits and a consumer that keeps its own memory use bounded. Limits apply to URI methods and cannot bound a provider's execution time or resource use. See [memory and storage](FILE-HANDLING.md#memory-and-storage).

Managed cache copies and browser Blob URLs are temporary. Release them after use and copy important data into persistent application storage. A provider that ignores cancellation can keep native I/O pending after reset; a process interruption after committing a copy but before delivering its ID can leave that copy until cache removal. See [failed and interrupted work](FILE-HANDLING.md#failed-and-interrupted-work).

## Verification boundaries

- Automated Android tests use controlled providers. They cover byte correctness, bounded copies, lifecycle behavior, and limits, but do not qualify real Drive or Photos accounts.
- iOS application archives are unsigned. Installation/build checks do not establish signed TestFlight or App Store behavior. Physical-device gestures and cloud-provider availability need application testing.
- Browser cancellation requires a browser that emits file-input `cancel` events. Dismissing a dialog in a browser without that support can leave the request pending. Playwright WebKit coverage does not establish every Safari/OS combination.

The [verification guide](VERIFICATION.md) describes the automated lanes and interactive checks. Failing tests remain failures in CI; prerelease acceptance of a documented limitation does not mean full qualification has passed.
