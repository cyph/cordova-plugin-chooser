# Verification and dependency maintenance

Chainman owns toolchains, dependencies, updates, and verification locally and in CI. Normal setup and verification use frozen dependencies without refreshing locks or checksum metadata.

## Setup and hosts

From a checkout with Git, Nix with flakes enabled, and `just`:

```sh
just setup
just doctor
```

[chainman.lock](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman.lock) selects an immutable runtime. The [Nix flake](https://github.com/cyph/cordova-plugin-chooser/blob/master/flake.nix) and its lockfile supply language tools and platform tooling. The frozen pnpm graph supplies Cordova CLI and platform aliases. Setup installs those dependencies and repository Git hooks; rerun it after configuration or toolchain changes. Stale setup stops tasks before execution.

Use the supplied Node, pnpm, Java, Gradle, and browser tools. Node's major family and pnpm's artifact are pinned under `chainman/`. Applications consuming the plugin do not need this development toolchain.

| Work | Host requirement |
| --- | --- |
| Portable checks | Linux or macOS, host/container Nix |
| Browser integration | Linux, host/container Nix |
| Android dependency preparation | Linux or supported macOS, including Linux ARM; host Nix |
| Full Android verification | Linux x86_64 or supported macOS; host Nix |
| iOS verification | macOS with the selected Xcode installation; host Nix |
| Capacitor Android emulator | Linux x86_64 with readable/writable `/dev/kvm`; host Nix |
| iOS simulator | macOS with the baseline Xcode and iOS 26.2 simulator runtime; host Nix |

Linux Android build tools are x86_64 executables. Dependency preparation is available on Linux ARM because it does not execute those tools. Full Android tasks reject that host before building.

Xcode is an external prerequisite. [apple.json](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/apple.json) and [apple-modern.json](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/apple-modern.json) pin each Apple profile's Xcode build, iPhoneOS SDK, and developer directory. The verifier checks those identities and rejects mismatched explicit `DEVELOPER_DIR` selections. It uses Apple's launchers while retaining the Nix-owned language tools. Inherited macOS-only SDK overrides are cleared for iOS builds.

## Commands

| Command | Coverage |
| --- | --- |
| `just verify` | Portable checks and browser integration; requires Linux |
| `just chainman run verify-portable` | JavaScript, typings, tooling, privacy declarations, source registration, and package checks |
| `just verify-browser` | Packed plugin in Chromium, Firefox, and WebKit through Cordova Browser; removal/reinstallation |
| `just verify-android-dependencies` | Strict resolution and staging of frozen Robolectric SDK JARs |
| `just verify-android` | Android 14/15 fixtures, API 24/28/30/33/35 Robolectric tests, debug/release lint, packed debug/release APK builds, and reinstallation |
| `just verify-android-failures` | Isolated missing/corrupted SDK and offline-loading failure cases |
| `just verify-ios` | Foundation fixtures and unsigned Cordova iOS 7/8 debug/release archives, including privacy-bundle coexistence |
| `just verify-ios-modern` | Both iOS generations on the modern Apple profile, plus Foundation address/thread sanitizers |
| `just verify-ios-simulator` | App-hosted XCTest and Files UI tests on fresh iPhone 17 and iPad (A16) simulators, for both Cordova iOS generations |
| `just verify-capacitor-android` | Packed plugin through Capacitor 8.5.2's real WebView/native bridge on an Android 13 emulator |
| `just verify-native` | Android and baseline iOS tasks; host must satisfy both profiles |
| `just clean` | Remove generated verification apps, reports, and Android fixture build output |

The modern Apple, simulator, Capacitor emulator, and Android dependency-failure tasks are separate from `verify-native`. Only the explicitly named simulator/emulator tasks launch virtual devices. Signing and store acceptance require separate application qualification.

## Automated coverage

JavaScript contract tests load production bridge/proxy code in isolated contexts. They cover binary decoding, padding, overloads, cancellation, duplicate completion, limits, and cleanup. TypeScript fixtures check the public declarations and reject invalid calls. Portable checks also validate registration, legal files, privacy resources, and package contents.

Integration tasks install the packed plugin into disposable applications using frozen platform aliases. npm subprocesses are offline with lifecycle scripts disabled. Removal/reinstallation checks complement source tests.

Browser tests exercise selection, limits, release, failures, and navigation through the registered bridge in three engines. CSP cases independently block or permit managed Blob URL reads and image previews. Automated empty selections do not establish real cancel-dialog behavior, and Playwright WebKit does not establish complete Safari/OS compatibility.

Android host fixtures compile production sources against Cordova 14/15 and SDK 35/36. Separate Robolectric tasks execute API 24, 28, 30, 33, and 35 tests, requiring nonempty, unskipped JUnit results. Provider doubles exercise metadata, PDF descriptor/pipe reads, MIME intent wiring, stream failures, cancellation, restoration, and reset through Cordova's dispatcher. Generated 45 MiB and 128 MiB copies are compared with streaming hashes, exercise exact/exceeded byte limits, and verify small bridge results and preservation of originals. Debug/release lint must have no untriaged issues. Packed release APK checks follow the resource table to the actual config XML and require both Chooser registration and the DEX entrypoint.

Foundation tests compile production iOS helpers without UIKit/Cordova and run as macOS executables. They cover streams, budgets, partial writes, ownership, transactions, recovery, and worker capacity. Both Apple lanes enable complete concurrency diagnostics in Swift 5 mode; packed applications separately compile UIKit/Cordova integration with Swift warnings treated as errors. The Cordova application archives target iOS 15.0. Older source fallbacks do not establish coverage below that deployment target.

Cordova iOS 7's generated bridging header suppresses deprecated-declaration diagnostics only while importing its older umbrella header; plugin Swift diagnostics remain strict. Its simulator host follows the generated app's static-library/header integration with implicit Swift modules. The Cordova 8 simulator host uses the framework target and explicit modules. The modern lane additionally runs separate AddressSanitizer and ThreadSanitizer Foundation binaries on macOS. Each Apple lane builds both Cordova generations, with fresh debug archives before removal and after reinstallation, then fresh release archives.

Privacy checks verify coexistence with an app declaration and another plugin's bundle through prepare, removal/reinstallation, and archive inspection. Synthetic declarations are test inputs.

### Simulator and framework integration

The simulator lane uses Nix-owned XcodeGen to build a fixture around the packed plugin, generated Cordova bridge assets/configuration, and each frozen Cordova framework. Simulator app/test bundles use ad-hoc signatures without a developer identity or provisioning profile. App-hosted tests invoke the production picker and delegates to check adaptive dismissal, stale/duplicate completion, reset, metadata, and type identifiers. UI tests exercise Cancel/reopen, a sheet swipe, and selection of synthetic local CSV, JSON, PDF, image, MP4, and MOV documents. Before booting simulators, a generator compiled with the pinned Xcode creates valid PNG/PDF documents and short H.264 MP4/MOV files using Apple's frameworks, then decodes or inspects each output. A separate Files-enabled fixture app supplies the documents, and source hashes, sizes, and file identifiers must remain unchanged after selection. The test presenter sets that app's document directory as the starting location and can force sheet presentation to exercise the historical dismissal route; production presentation is unchanged. Movie fixtures test selection/type handling, not playback. Every device/platform combination must execute all required cases without skips. Reports retain xcresult bundles and test summaries.

The Android emulator lane freezes Capacitor core/CLI/Android at 8.5.2, uses JDK 21, and compiles against SDK/Build Tools 36. Its small Gradle adapter compiles the framework's unmodified npm sources with a separately locked graph; the CLI generates Cordova assets and registration from the packed plugin. Espresso Intents supplies deterministic document-provider results, while the real JavaScript bridge, plugin, provider reads, copies, and release operation execute in an Android 13/API 33 WebView. Generated 45 MiB and 128 MiB files exercise hashes, exact/exceeded limits, small result payloads, and source preservation. An asynchronously written, unknown-length pipe exercises PDF bytes in data and copy modes on Android itself. Controlled cancellation checks reopening. These intent responses do not test the system picker's UI or real Drive/Photos behavior.

Nix owns the emulator and Google APIs x86_64 system image. The task creates its own AVD and removes it after execution. Simulator tasks similarly create and delete only their own devices. No cloud accounts or personal files are required. Runtime fingerprints, command logs, and instrumentation results accompany the reports. Passing these fixtures does not reproduce historical iOS 14/15 gestures, customer workloads, provider accounts, or signed TestFlight distribution.

## Android dependency ownership

AAPT2 comes from the pinned Nix Android SDK: Build Tools 35.0.0 for Android 14 and 36.0.0 for Android 15. The verifier validates the executable and passes `android.aapt2FromMavenOverride` explicitly to fixture Gradle commands and disposable Cordova builds. Cordova's Gradle wrapper uses a local, hash-pinned Nix distribution URL.

Robolectric's SDKs have separate resolvable configurations so resolving one version cannot evict another:

| Role with Robolectric 4.16.1 and JDK 17 | Frozen artifact |
| --- | --- |
| API 24 runtime | `org.robolectric:android-all-instrumented:7.0.0_r1-robolectric-r1-i7` |
| API 28 runtime | `org.robolectric:android-all-instrumented:9-robolectric-4913185-2-i7` |
| API 30 runtime | `org.robolectric:android-all-instrumented:11-robolectric-6757853-i7` |
| API 33 runtime | `org.robolectric:android-all-instrumented:13-robolectric-9030017-i7` |
| API 35 runtime and compile-time SDK | `org.robolectric:android-all-instrumented:15-robolectric-13954326-i7` |

Both fixtures lock and checksum these artifacts. `prepareRobolectricSdks` validates them and stages their original filenames in `build/robolectric-sdks`. Normal tests depend on preparation and use Robolectric offline mode with that explicit directory. Missing files must fail rather than trigger an implicit download. Lint's tool graph is also exposed to dependency resolution for lock/checksum maintenance.

Robolectric selects its compile-time SDK independently of Android's `compileSdk`, subject to JDK support. Coordinate changes to Robolectric, JDK, instrumentation suffixes, and all SDK pins in the [shared catalog](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/android/gradle/libs.versions.toml). Update the matching exact Robolectric constraint in the update configuration, then resolve both fixture graphs and review their locks/checksums together.

`verify-android-failures` uses disposable projects and isolated Gradle homes. It checks cold/warm preparation, checksum rejection after corruption, offline failure after deleting a cached JAR, and Robolectric failure after deleting a staged JAR. Fingerprints must show unchanged tracked dependency metadata. Run destructive cases only in those isolated fixtures.

## Dependency updates

Policy and adapters are declared in [updates.toml](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/updates.toml) and [dependencies.toml](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/dependencies.toml). Start with:

```sh
just chainman config validate
just chainman deps-check
just chainman deps-coverage
just chainman deps-policy-report
just deps-update mode=dry-run targets=js
```

After reviewing a preview, apply the corresponding update:

```sh
just deps-update targets=js
```

Updates use isolated checkouts and normally commit after verification. Run them on Linux for browser coverage, then qualify relevant native lanes for platform or native changes.

Selection uses a 30-day maturity window with expiring policy exceptions. The `nix` target group reconciles Nix, language tools, and JavaScript/native graphs. Platform aliases retain separate major families; Actions use immutable pins. Maintain Apple SDK selections explicitly.

Use `targets=android` to update the two Cordova fixture graphs. Use `targets=android-sdks` to refresh evidence for the frozen SDK graph without selecting newer SDK releases; preview either with `mode=dry-run`. Review unchanged SDK identities when doing an evidence-only refresh, and keep both fixtures' lockfiles and complete checksum metadata together.

Use `targets=capacitor` to refresh the frozen emulator graph. A Capacitor upgrade is coordinated: change core/CLI/Android pins and their exact policy constraints together, review the framework adapter against upstream build settings and dependencies, refresh the pnpm and Gradle graphs, then qualify the emulator lane. SDK, JDK, Gradle, and instrumentation dependencies must remain compatible. Resolution-only changes do not qualify runtime behavior.

Run `just chainman deps-audit --targets js` for published dependency advisories. Coverage depends on available ecosystem evidence; passing tests are not a security audit. Use `just chainman chainman-update` for runtime upgrades. Setup and verification never advance `chainman.lock`.

## CI and reports

The [Verify workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/verify.yml) runs on public-repository pull requests, pushes to `master` or `candidate/**`, and manual dispatch. It invokes the same tasks with read-only repository permissions, pinned Actions, and finite timeouts.

Its final qualification job requires successful portable, Android, dependency-failure, baseline iOS, modern iOS, iOS simulator, and Capacitor Android jobs. It validates eight lane reports, including the browser report, for matching commit, package version, and package integrity. Missing reports, skipped lanes, missing required native cases, or failed commands reject qualification.

Reports and command logs live under `.verification/reports/`; Actions retains them for 14 days, including on failure. Check downloaded evidence with `just chainman run qualify`, supplying `CHOOSER_REPORTS_ROOT`, `GITHUB_SHA`, and the workflow's `CHOOSER_JOB_RESULTS` JSON. Keep per-run evidence in CI or the pull request.

## Interactive checks

Use the [manual fixture app](https://github.com/cyph/cordova-plugin-chooser/tree/master/tests/fixture-app/www) and [native scenarios](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/native-cases.json) with disposable files. Copy the fixture's `www` contents into a Cordova app with the plugin installed.

Check genuine cancellation, repeated and concurrent calls, local/cloud providers, revoked access, empty and binary files, exact/exceeded limits, low storage, cache eviction, and release after consumption. Exercise Android activity/process recreation, iOS presentation/orientation, and browser back/forward navigation. Compare copied bytes as well as metadata.

For lifecycle or transaction changes, include reset during blocked reads, second-file batch failure, short writes, and interruption around promotion/commit. Check private-output cleanup while ensuring originals remain intact. Record devices, providers, and results with the release review; build-only and host-fixture checks do not establish these behaviors.

## Release preparation

1. Align `package.json`, `plugin.xml`, the installation examples, migration guide, and changelog with the intended version. Record verified npm publication dates in UTC, not commit or build dates.
2. Run the full workflow for the exact revision and inspect final qualification. Complete the interactive checks relevant to the changes.
3. Inspect the qualified npm archive, including documentation links, types, native resources, license, and notices. Repository-only tooling links should use repository URLs. Any packaged edit changes integrity and requires qualification of the resulting package.
4. Publish the qualified artifact with an explicitly chosen distribution tag. For prereleases, choose a prerelease tag such as `next`; the version suffix alone does not protect `latest`. See [npm distribution tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/).
5. Verify registry version, tag assignment, publication timestamp, and package integrity. Create the corresponding repository tag and release notes as deliberate release operations. Add a confirmed publication date to the source changelog without attempting to republish the same version.
