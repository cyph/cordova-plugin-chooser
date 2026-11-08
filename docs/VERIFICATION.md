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
| `just chainman run verify-ios-simulator-part cordova-ios7 iphone` | Required cases in one partition; choose `cordova-ios7` or `cordova-ios8`, and `iphone` or `ipad` |
| `just chainman run verify-ios-simulator-part cordova-ios7 iphone --investigation-only` | Isolated provider cases in that partition |
| `just chainman run diagnose-ios-simulator` | Focused baseline iPhone picker diagnostic; see below for variants |
| `just chainman run compare-ios-releases cordova-ios7 iphone` | Manual RC1/RC2 comparison in one partition; choose `cordova-ios7` or `cordova-ios8`, and `iphone` or `ipad` |
| `just verify-capacitor-android` | Packed plugin through the Capacitor Android bridge on an emulator |
| `just verify-native` | Android and baseline iOS tasks on a host meeting both requirements |
| `just clean` | Remove generated verification apps, reports, and Android fixture output |

`verify-native` does not include the modern iOS, simulator, Capacitor emulator, or Android dependency-failure tasks. The simulator and emulator commands create their own virtual devices.

## Automated coverage

Portable tests exercise the Promise API, cancellation exceptions, decoding, explicit budgets, resource ownership, cleanup outcomes, declarations, registration, and package contents. The type lane checks TypeScript 5.7 and the pinned current compiler, including DOM compatibility of returned byte arrays. Browser integration exercises the installed plugin, managed URLs, failures, navigation, and content security policies. Automated empty selections do not prove real dialog cancellation; Playwright WebKit does not establish full Safari or OS compatibility.

Android fixtures exercise production code through Cordova, including provider behavior, streams, limits, lifecycle, and cleanup. Robolectric covers API 24, 28, 30, 33, and 35; packed builds and lint cover both supported Cordova Android families. The Capacitor emulator runs the real bridge and provider reads with controlled intent responses; it does not exercise the system picker UI or real cloud providers.

iOS Foundation fixtures test I/O, budgets, transactions, recovery, and worker ownership. The archive tasks compile the plugin with both supported Cordova iOS families and check privacy-resource coexistence. Their deployment target is iOS 15, matching the plugin minimum. Builds alone do not establish picker behavior on every supported iOS version. The simulator matrix adds app-hosted and Files UI tests, including selection, cancellation, reopening, and independent UIKit controls. See [known limitations](KNOWN-ISSUES.md) for iOS Files failures observed in simulator tests.

### File-reading comparison

Use the comparison fixture when changing reading or resource ownership. It sends identical content through managed streams, managed byte reads, and each direct-data format, checking content parity and cleanup while recording chunk sizes, bridge payloads, and modeled copy/storage costs.

```sh
just chainman exec --profile toolchain -- node scripts/benchmark-files.mjs --output <path>
```

Replace `<path>` with the destination JSON file. This is a synthetic JavaScript comparison with an in-memory Cordova bridge: timings do not measure native/device throughput, and copy counts do not measure filesystem writes or provider imports. Use the report to compare the paths and investigate changes; the fixture's regression tests also run in the portable lane.

### Simulator and framework integration

For a focused investigation, run `just chainman run diagnose-ios-simulator` for baseline Cordova iOS 7 on iPhone. Use `diagnose-ios-simulator-ipad`, `diagnose-ios-simulator-modern`, or `diagnose-ios-simulator-modern-ipad` for the other device and Apple profile combinations. Append `--dismissal-only` for cancellation and dismissal checks or `--provider-only` for the provider comparison. The [Verify workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/verify.yml) also offers manual diagnostic profile, device, and scope inputs.

Required CI runs all four framework/device partitions with an explicit manifest. Seven known case/partition combinations are isolated: UIKit CSV in all four partitions, UIKit PDF in both iPhone partitions, and Chooser CSV in Cordova iOS 8/iPad. They remain in the manually dispatched [iOS provider investigation workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/ios-provider-investigation.yml), with their assertions and artifacts intact. Preparation and test failures still fail that workflow.

`just verify-ios-simulator` runs the complete local suite, including the isolated cases. Use partition commands without a flag for required CI coverage, or append `--investigation-only` for the affected cases in that partition. Focused diagnostics and investigation reports cannot substitute for required qualification. The aggregator checks exact case manifests, source revision, package identity, and all required partitions; mixed, missing, or diagnostic coverage is rejected.

Return the isolated cases to required CI after three consecutive clean runs across all affected partitions on fresh simulators. Moving a case to the investigation workflow does not resolve it; keep [known issues](KNOWN-ISSUES.md) aligned with the actual exclusions.

### Manual iOS release comparison

Run the partition command above locally or dispatch the manual-only [iOS release comparison workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/ios-release-comparison.yml), which runs all four framework/device partitions. It compares the checksum-pinned published RC1 with the committed RC2 archive using the same pinned baseline Apple toolchain, simulator runtime, SDK, framework, and harness. Each partition follows the fixed sequence UIKit, RC1, RC2, RC2, RC1, UIKit, with a fresh simulator and provider store for every entry.

The plugin cases cover metadata for six formats and cancellation/reopening; UIKit controls cover JSON, CSV, and PDF import and open. RC1 metadata imports and RC2 opens in place: this difference is intentionally preserved. Stage caps total 340 minutes within the 360-minute job limit. Do not cycle runs until green; retain failures, timeouts, and unstarted cases alongside successes. Reports include `comparison.json`, xcresult bundles, logs, and hash manifests. This comparison cannot count as required qualification.

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

For a GitHub Actions preview, manually run [Dependency preview](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/dependency-preview.yml) and choose `android` (the default, covering the Cordova Android 14/15 graphs), `android-sdks` (evidence for frozen SDK pins), or `capacitor`. On Ubuntu, it runs the pinned Chainman command `just deps-update mode=dry-run targets=<choice> commit=off --json`, including project verification, without applying repository updates or commits. Review the structured JSON result and command log in the workflow artifact. Frozen release qualification remains separate.

Updates use isolated checkouts and normally commit after verification. Run them on Linux for browser coverage, then run the relevant native lanes. Use `targets=nix` to reconcile Nix and toolchain pins with the JavaScript and native dependency graphs. Use `targets=android` for both Cordova Android fixture graphs, `targets=android-sdks` to refresh evidence for the existing SDK pins, and `targets=capacitor` for the emulator graph; preview each with `mode=dry-run`. When refreshing SDK evidence, verify that SDK identities remain unchanged and review both fixtures' locks and checksums.

For a Capacitor upgrade, coordinate core, CLI, Android, policy constraints, the Gradle adapter, and the pnpm and Gradle graphs; then run the emulator lane. Check SDK, JDK, Gradle, and instrumentation compatibility. Use `just chainman deps-audit --targets js` for available published advisories and `just chainman chainman-update` to update the pinned Chainman runtime.

## CI and reports

The [Verify workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/verify.yml) runs the verification lanes on pull requests, pushes to `master`, and manual dispatch. Qualification combines their reports for the same revision and package. Simulator partitions run separately in CI.

Find local command logs, summaries, and result bundles under `.verification/reports/`; workflow artifacts retain reports on failure as well as success. Simulator results include xcresult bundles and diagnostic summaries when tests execute. A setup failure is reported as tests not started; it is not evidence of a test pass or a separate missing-result failure. Recognized transient dependency transport failures may be retried with bounded backoff; integrity, lock, and assertion failures are not treated as transient. To check downloaded evidence, run `just chainman run qualify` with `CHOOSER_REPORTS_ROOT`, `GITHUB_SHA`, and the workflow's `CHOOSER_JOB_RESULTS` JSON set for the run.

## Interactive checks

Use the [manual fixture app](https://github.com/cyph/cordova-plugin-chooser/tree/master/tests/fixture-app/www) and [native scenarios](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/native-cases.json) with disposable files. Copy the fixture's `www` contents into a Cordova app with the plugin installed.

Exercise document and Photos selection, cancellation and abort signals, repeat and concurrent calls, local and cloud providers, revoked access, empty and binary files, byte/count limits, low storage, cache eviction, restoration, and release across aliases. Confirm scoped cleanup preserves completed results, and that releasing a file stops streams without hanging on an unread stream. Check Android activity recreation, iOS presentation and orientation, and browser navigation. Compare copied bytes as well as metadata. For lifecycle or transaction changes, also test reset during a blocked read, batch failure, short writes, and interruption around commit; confirm cleanup preserves original files.

## Release preparation

1. Align package and plugin versions, exact-version installation examples, migration guide, and changelog before packing. Describe the version without development-only wording or a claim that publication has occurred. Use a version link for the changelog heading and leave its date unset until publication is verified.
2. Run the main workflow for the release revision and package, inspect every required gate, and perform relevant interactive checks. Run the separate provider investigation workflow and retain its evidence. Do not count its accepted failures as fixed or substitute its reports for required coverage. Document unverified device/provider behavior in the release review.
3. Inspect the npm archive for documentation links, types, native resources, license, and notices. Verify the resulting package after any packaged change.
4. Publish the reviewed artifact with an explicit distribution tag. Use a prerelease tag such as `next` for a prerelease: the version suffix alone does not keep it off `latest`. Link release notes to [known limitations](KNOWN-ISSUES.md) and describe accepted verification gaps.
5. Confirm registry version, distribution tag, timestamp, and integrity. Tag the qualified source revision and record the verified UTC publication date and package integrity in the GitHub release. Keep the published archive identical to the qualified artifact; the registry metadata and GitHub release record its publication date without requiring a repackaged changelog.
