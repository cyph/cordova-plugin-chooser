# Verification and dependency maintenance

Use these tasks to check a contribution or prepare a release. Chainman runs the same pinned tools and frozen dependencies locally and in CI; ordinary verification does not update locks.

## Setup and hosts

Install Git, Nix with flakes enabled, and `just`, then run `just setup` and `just doctor`. Setup installs dependencies and Git hooks; repeat it after changing toolchain or dependency configuration. The [flake](https://github.com/cyph/cordova-plugin-chooser/blob/master/flake.nix), [Chainman configuration](https://github.com/cyph/cordova-plugin-chooser/tree/master/chainman), and [runtime pin](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman.lock) define the tools used by these tasks.

| Work | Host and prerequisites |
| --- | --- |
| Portable checks | Linux or macOS with host or container Nix |
| Browser integration | Linux with host or container Nix |
| Android dependency preparation | Linux or supported macOS, including Linux ARM; host Nix |
| Full Android checks | Linux x86_64 or supported macOS; host Nix. Linux Android build tools do not run on ARM |
| iOS builds | macOS, host Nix, and the selected Xcode installation |
| iOS simulator | macOS, host Nix, baseline Xcode, and the iOS 26.5 simulator runtime |
| Capacitor Android emulator | Linux x86_64, host Nix, and readable/writable `/dev/kvm` |

Xcode is installed separately. The [baseline](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/apple.json) and [modern](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/apple-modern.json) profiles specify the required Xcode build, SDK, and developer directory. An explicitly selected `DEVELOPER_DIR` must match the profile; modern simulator diagnostics also require its corresponding runtime.

## Commands

| Command | Purpose |
| --- | --- |
| `just verify` | Portable and browser checks on Linux |
| `just chainman run verify-portable` | JavaScript, types, tooling, registration, privacy, and package checks |
| `just verify-browser` | Packed plugin through Cordova Browser in Chromium, Firefox, and WebKit |
| `just verify-android-dependencies` | Resolve and stage the frozen Robolectric SDKs |
| `just verify-android` | Cordova Android 14/15 fixtures, Robolectric tests, lint, APK builds, and reinstallation |
| `just verify-android-failures` | Isolated missing, corrupt, and offline dependency failure checks |
| `just verify-ios` | Foundation fixtures and unsigned Cordova iOS 7/8 archives |
| `just verify-ios-modern` | iOS builds with the modern Apple profile and Foundation sanitizers |
| `just verify-ios-simulator` | Full iPhone/iPad and Cordova iOS 7/8 simulator matrix |
| `just chainman run verify-ios-simulator-part cordova-ios7 iphone` | One matrix partition; choose `cordova-ios7` or `cordova-ios8`, and `iphone` or `ipad` |
| `just chainman run diagnose-ios-simulator` | Focused baseline iPhone picker diagnostic; see below for variants |
| `just verify-capacitor-android` | Packed plugin through the Capacitor Android bridge on an emulator |
| `just verify-native` | Android and baseline iOS tasks on a host meeting both requirements |
| `just clean` | Remove generated verification apps, reports, and Android fixture output |

`verify-native` does not include the modern iOS, simulator, Capacitor emulator, or Android dependency-failure tasks. The simulator and emulator commands create their own virtual devices.

## Automated coverage

Portable tests cover bridge contracts, callbacks, cancellation, decoding, limits, cleanup, declarations, registration, and package contents. Browser integration exercises the installed plugin, managed URLs, failures, navigation, and content security policies. Automated empty selections do not prove real dialog cancellation; Playwright WebKit does not establish full Safari or OS compatibility.

Android fixtures exercise production code through Cordova, including provider behavior, streams, limits, lifecycle, and cleanup. Robolectric covers API 24, 28, 30, 33, and 35; packed builds and lint cover both supported Cordova Android families. The Capacitor emulator runs the real bridge and provider reads with controlled intent responses; it does not exercise the system picker UI or real cloud providers.

iOS Foundation fixtures test I/O, budgets, transactions, recovery, and worker ownership. The archive tasks compile the plugin with both supported Cordova iOS families and check privacy-resource coexistence. Their deployment target is iOS 15; source fallbacks do not establish coverage below it. The simulator matrix adds app-hosted and Files UI tests, including selection, cancellation, reopening, and independent UIKit controls. See [known limitations](KNOWN-ISSUES.md) for iOS Files failures observed in simulator tests.

### Simulator and framework integration

For a focused investigation, run `just chainman run diagnose-ios-simulator` for baseline Cordova iOS 7 on iPhone. Use `diagnose-ios-simulator-ipad`, `diagnose-ios-simulator-modern`, or `diagnose-ios-simulator-modern-ipad` for the other device and Apple profile combinations. Append `--dismissal-only` for cancellation and dismissal checks or `--provider-only` for the provider comparison. The [Verify workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/verify.yml) also offers manual diagnostic profile, device, and scope inputs.

Focused diagnostics help investigate a failure; they do not replace `just verify-ios-simulator`. Release qualification requires the complete matrix, either in one local run or all four framework/device partitions together.

## Android dependency ownership

AAPT2 comes from the pinned Nix Android SDK. Verification supplies its path through `android.aapt2FromMavenOverride` to fixture Gradle commands and disposable Cordova builds. The Gradle distribution is also pinned by Nix.

Each Robolectric SDK has its own resolvable configuration, so resolution cannot evict another SDK. The fixtures lock and checksum the artifacts; `prepareRobolectricSdks` stages them in `build/robolectric-sdks`. Tests use that directory in offline mode: missing SDKs fail instead of downloading implicitly. `just verify-android-failures` exercises this behavior in isolated fixtures.

Robolectric chooses its compile-time SDK independently of Android's `compileSdk`, subject to JDK support. Coordinate Robolectric, JDK, instrumentation suffix, and SDK changes in the [shared version catalog](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/android/gradle/libs.versions.toml) and the matching constraint in [update configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/updates.toml). Resolve both fixture graphs and review their locks and checksums together.

## Dependency updates

Update selection follows the release-age and version policies in [update configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/updates.toml) and [dependency configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/dependencies.toml). Preview and apply the desired target:

```sh
just chainman config validate
just chainman deps-check
just chainman deps-coverage
just chainman deps-policy-report
just deps-update mode=dry-run targets=js
just deps-update targets=js
```

Updates use isolated checkouts and normally commit after verification. Run them on Linux for browser coverage, then run the relevant native lanes. Use `targets=nix` to reconcile Nix and toolchain pins with the JavaScript and native dependency graphs. Use `targets=android` for both Cordova Android fixture graphs, `targets=android-sdks` to refresh evidence for the existing SDK pins, and `targets=capacitor` for the emulator graph; preview each with `mode=dry-run`. When refreshing SDK evidence, verify that SDK identities remain unchanged and review both fixtures' locks and checksums.

For a Capacitor upgrade, coordinate core, CLI, Android, policy constraints, the Gradle adapter, and the pnpm and Gradle graphs; then run the emulator lane. Check SDK, JDK, Gradle, and instrumentation compatibility. Use `just chainman deps-audit --targets js` for available published advisories and `just chainman chainman-update` to update the pinned Chainman runtime.

## CI and reports

The [Verify workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/verify.yml) runs the verification lanes on pull requests, relevant branch pushes, and manual dispatch. Qualification combines their reports for the same revision and package. Simulator partitions run separately in CI.

Find local command logs, summaries, and result bundles under `.verification/reports/`; workflow artifacts retain reports on failure as well as success. Simulator results include xcresult bundles and diagnostic summaries. To check downloaded evidence, run `just chainman run qualify` with `CHOOSER_REPORTS_ROOT`, `GITHUB_SHA`, and the workflow's `CHOOSER_JOB_RESULTS` JSON set for the run.

## Interactive checks

Use the [manual fixture app](https://github.com/cyph/cordova-plugin-chooser/tree/master/tests/fixture-app/www) and [native scenarios](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/native-cases.json) with disposable files. Copy the fixture's `www` contents into a Cordova app with the plugin installed.

Exercise cancellation, repeat and concurrent calls, local and cloud providers, revoked access, empty and binary files, limits, low storage, cache eviction, and release after consumption. Check Android activity recreation, iOS presentation and orientation, and browser navigation. Compare copied bytes as well as metadata. For lifecycle or transaction changes, also test reset during a blocked read, batch failure, short writes, and interruption around commit; confirm cleanup preserves original files.

## Release preparation

1. Align package and plugin versions, installation examples, migration guide, and changelog. Use verified npm publication dates in UTC.
2. Run the full workflow for the release revision, inspect qualification, and perform relevant interactive checks. An RC may ship with an accepted, documented limitation and failed qualification; record its impact and evidence in the release review. Full stable qualification requires all mandatory gates to pass.
3. Inspect the npm archive for documentation links, types, native resources, license, and notices. Verify the resulting package after any packaged change.
4. Publish the reviewed artifact with an explicit distribution tag. Use a prerelease tag such as `next` for a prerelease: the version suffix alone does not keep it off `latest`. Link release notes to [known limitations](KNOWN-ISSUES.md) and describe accepted verification gaps.
5. Confirm registry version, tag, timestamp, and integrity. Create the repository tag and release notes, and add the confirmed publication date to the source changelog.
