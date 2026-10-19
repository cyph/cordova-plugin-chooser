# Verification and dependency maintenance

Use the same chainman commands locally and in CI. Toolchain definitions, frozen dependencies and update policy are checked in; verification must not refresh dependency locks.

## Setup

Install Git, Nix with flakes enabled, and `just`, then run:

```sh
just setup
just doctor
just verify
```

Chainman fetches the immutable runtime selected by `chainman.lock` and supplies language tools through Nix. Do not install separate Node, pnpm, Java, Gradle or Playwright versions. No sibling chainman checkout is needed. `setup` installs the frozen pnpm graph and Git hooks; rerun it after toolchain/configuration changes. A stale setup stops tasks before execution. CI runs setup explicitly.

The flake owns Node's major family, JDK 17, Gradle, Android SDKs, CocoaPods and matching Playwright/browser binaries. `flake.lock` pins package definitions; `chainman/tools.json` pins pnpm's registry artifact and integrity, and reconciles `packageManager`. Host-specific Node patches can differ within the declared major family. Browser tasks use pinned software rendering for headless Linux. The frozen pnpm graph supplies Cordova CLI and platform aliases; the plugin itself has no production npm dependencies.

## Commands and coverage

| Command | Environment | Coverage |
| --- | --- | --- |
| `just verify` | Linux, host/container Nix | JavaScript, typings, tooling regressions, package checks and three browser engines |
| `just chainman run verify-portable` | Linux/macOS, host/container Nix | JavaScript, typings, tooling and package checks without browser execution |
| `just verify-browser` | Linux, host/container Nix | Packed plugin in Cordova browser; Chromium, Firefox and WebKit |
| `just verify-android-dependencies` | Linux/macOS, including Linux ARM; host Nix | Strict resolution and staging of frozen Robolectric SDK JARs without running Android binaries |
| `just verify-android` | Linux x86_64 or supported macOS; host Nix | Android 14/15 JUnit/Robolectric fixtures and packed-plugin Cordova debug builds |
| `just verify-ios` | macOS, host Nix and selected Xcode | Foundation fixtures and unsigned Cordova iOS 7/8 device-target builds |
| `just verify-native` | Host satisfying both native profiles | Both native lanes |
| `just clean` | Project toolchain profile | Removes disposable applications and fixture output |

Android Linux build tools are x86_64 executables, so full Android execution fails preflight on Linux ARM. Dependency preparation remains available there. Neither native lane launches an emulator, simulator or device.

Apple's licensed SDK is an external prerequisite. `chainman/apple.json` owns the Xcode version/build, iPhoneOS SDK and developer directory. The iOS lane selects that directory or validates an explicit `DEVELOPER_DIR`; mismatches fail. The [macOS 15 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md) lists available Xcode installations. When changing this contract, qualify both supported Cordova iOS generations.

The verifier calls Apple's `/usr/bin/xcodebuild` and `/usr/bin/xcrun` launchers explicitly. It exposes the selected developer tools and standard macOS utilities to Cordova's subprocesses while retaining the Nix-owned language tools in their search path.

Nix's macOS-only developer-directory default is replaced with the pinned Xcode directory for this lane, and its inherited `SDKROOT` is cleared so Apple tools can select the requested SDK. Explicit host Xcode selections still undergo the same version/build and iPhoneOS SDK checks.

## Automated fixtures

The JavaScript suite loads the production bridge/proxy in isolated VM contexts. It checks binary/base64 accuracy, callback forms, cancellation, duplicate settlement, limits, failed batches and resource ownership. TypeScript fixtures check public methods, result unions and invalid calls. Package checks verify source registration and install the packed artifact into disposable apps, using the frozen platform aliases.

Disposable applications link the frozen platform packages and their declared dependencies under their canonical names. Cordova resolves those exact installed versions, including the extracted plugin package, without reinstalling platform sources or running their development-only prepare scripts. Removal/reinstallation remains part of each integration lane; npm subprocesses are offline and have lifecycle scripts disabled.

Browser integration uses the actual registered bridge in Chromium, Firefox and WebKit. It exercises selection, bytes, metadata/copy paths without content reads, limits, failures, Blob release, navigation and remove/reinstall. Automated empty selections do not establish native cancel-dialog behavior. Playwright WebKit is not a complete Safari/OS integration claim.

Android fixtures compile production sources against Cordova 14/15 and Android SDK 35/36. JUnit covers counted streaming and cache ownership; Robolectric API 28 provider doubles cover metadata, cancellation, restoration, reset and failure cases. Dispatcher regressions use the actual Cordova interface. Separate packed-app builds check installation and resource processing.

Foundation fixtures compile production iOS helpers in Swift 5 mode and exercise streams, limits, partial writes, cancellation, ownership, batch recovery and worker capacity. They do not import UIKit/Cordova. Packed-app builds separately check those imports and source registration; live picker/provider behavior requires integration checks.

### Android dependency ownership

AAPT2 comes from the Nix-owned Android SDK, not an unpinned Gradle download: Build Tools 35.0.0 for Android 14 and 36.0.0 for Android 15. The runner validates the executable and passes `android.aapt2FromMavenOverride` to fixture Gradle commands and disposable Cordova builds. Cordova's Gradle wrapper uses a local, hash-pinned Nix distribution URL.

Robolectric uses two separately resolvable Gradle configurations so conflict resolution cannot evict one SDK in favor of the other:

| Role under JDK 17 | Frozen artifact |
| --- | --- |
| API 28 runtime | `org.robolectric:android-all-instrumented:9-robolectric-4913185-2-i7` |
| API 35 compile-time | `org.robolectric:android-all-instrumented:15-robolectric-13954326-i7` |

Both fixture graphs lock and checksum these artifacts. `prepareRobolectricSdks` validates and stages their original filenames in generated `build/robolectric-sdks` directories. Test tasks depend on preparation and configure Robolectric with offline loading and that explicit directory; missing files must not trigger implicit downloads. Generated copies and shared caches consume additional disk space; `just clean` removes fixture output.

Robolectric selects its compile-time SDK from the maximum supported by the JDK, independently of Android `compileSdk`; on JDK 17, the Android 15 fixture also uses API 35 for Robolectric. Coordinate Robolectric upgrades with its SDK mapping, instrumentation version, JDK and both frozen SDK pins. The tooling adapter's exact compatibility bound must change together with the catalog version after review.

### Dependency failure checks

Qualify Android lock updates with both fresh and warm Gradle caches. In disposable copies:

1. Resolve and stage both SDK roles with strict lock/checksum verification.
2. Remove a cached SDK JAR and require offline Gradle resolution to fail.
3. Corrupt an artifact and require strict checksum verification to fail.
4. Remove a staged JAR after preparation and check that Robolectric's offline resolver refuses it without downloading a replacement.
5. Compare tracked locks/checksum metadata before and after verification; they must remain unchanged.

Do not perform destructive dependency tests in the primary checkout or shared cache. These checks complement the normal native tasks; do not weaken strict verification to make a lane pass.

## Dependency updates

```sh
just chainman config validate
just chainman deps-check
just chainman deps-coverage
just chainman deps-policy-report
just deps-update mode=dry-run targets=js
just deps-update targets=js
just deps-update mode=dry-run targets=android
just deps-update mode=dry-run targets=android-sdks
```

Updates run in isolated checkouts and apply only declared outputs after the portable `verify` task succeeds. That gate requires Linux for browser execution. Native acceptance remains a separate requirement: run the relevant Android/iOS lanes on the resulting branch before release. Native dependency updates require the Android profile, not an Apple SDK.

Project dependencies have a 30-day maturity window. Nix input updates precede toolchain reconciliation and package resolution. The `nix` target group reconciles pnpm/Node and JavaScript/native locks. Platform aliases stay within their supported major families. Both Gradle adapters share a tooling catalog and retain separate Cordova generations. Actions use immutable SHAs and a dedicated update adapter. Apple SDK selection is maintained explicitly because chainman cannot install or redistribute Xcode.

The `android-sdks` target refreshes evidence for the frozen SDK graph without selecting newer SDK releases. Preview with `just deps-update mode=dry-run targets=android-sdks`, then apply with `just deps-update targets=android-sdks`. Review unchanged catalog versions, both prescribed SDK entries and the complete checksum metadata. Android adapters refresh repository metadata, including parent POMs/BOMs with warm caches, and run SDK preparation to validate resolved JARs.

Run `just chainman deps-audit --targets js` for published dependency advisories. Policy and expiring exceptions belong in the chainman configuration, not duplicated reports in documentation. Audit coverage depends on ecosystem evidence and network availability; passing tests are not a security audit. Use `just chainman chainman-update` for runtime updates. Normal setup and verification never advance `chainman.lock`.

## GitHub Actions

[Verify](../.github/workflows/verify.yml) runs on pull requests and pushes to `master` or `candidate/**`, with manual dispatch available. Standard Ubuntu runners execute the portable and Android jobs; macOS executes iOS. All call the same chainman tasks, with read-only repository permissions, immutable Action pins and finite timeouts. No signing accounts, package publication or deployment are required.

Require the portable, Android and iOS jobs to pass for the same candidate revision before release. Inspect failures and rerun affected lanes after fixes. Keep exact revisions, environment details and execution results in CI or the pull request, rather than accumulating dated reports here.

## Provider and OS integration

Use [native scenarios](../tests/native-cases.json) and the [manual fixture app](../tests/fixture-app/www/index.html) with disposable data. Check genuine cancel UI, cloud/download failures, revoked grants, rotation, process death, security-scoped access, swipe dismissal, orientation masks, disk exhaustion, cache eviction and browser back/forward-cache behavior.

Include rapid reopen, blocked reads after reset, second-file batch failure, short writes, and interruption around batch promotion/commit. Hash source/copy bytes and inspect cleanup. Synthetic fixtures and build-only jobs cannot establish these provider and UI behaviors.
