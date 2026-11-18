# Verification and dependency maintenance

Use this guide to choose checks for a change and interpret their evidence. Commands run through the project's pinned Chainman and Nix environment. Routine verification uses frozen dependencies rather than updating them. The [platform guide](PLATFORMS.md#requirements-and-coverage) summarizes user-facing support.

## Setup and hosts

Install Git, Nix with flakes, and `just`, then run `just setup` and `just doctor`. Repeat setup after toolchain or dependency changes. The repository's [flake](https://github.com/cyph/cordova-plugin-chooser/blob/master/flake.nix), [Chainman configuration](https://github.com/cyph/cordova-plugin-chooser/tree/master/chainman), and runtime pin define the tools.

| Check | Host requirements |
| --- | --- |
| Portable | Linux or macOS with host or container Nix |
| Cordova Browser | Linux with host or container Nix |
| Android dependency preparation | Linux or supported macOS with host Nix, including Linux ARM |
| Android builds and tests | Linux x86_64 or supported macOS with host Nix. Linux Android build tools do not run on ARM |
| iOS archives | macOS, host Nix, and the selected Xcode installation |
| iOS simulator | macOS, host Nix, baseline Xcode, and the iOS 26.5 simulator runtime |
| Capacitor Android emulator | Linux x86_64, host Nix, and readable/writable `/dev/kvm` |

Xcode is installed separately. The repository's [baseline](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/apple.json) and [modern](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/apple-modern.json) Apple profiles specify the Xcode build and SDK. An explicit `DEVELOPER_DIR` must match the chosen profile. Modern simulator diagnostics also need its corresponding runtime.

## Commands

Start with the rows that cover the boundary changed. A test lane's configured coverage is not evidence that a particular run passed.

| Changed area or question | Command | What it checks |
| --- | --- | --- |
| Shared JavaScript, declarations, registration, package, or privacy files | `just chainman run verify-portable` | Promise contract, budgets, decoding, ownership, types, tooling, registration, and package contents |
| General portable and browser changes on Linux | `just verify` | Portable checks and browser integration |
| Browser behavior and Blob URLs | `just verify-browser` | Packed plugin in Cordova Browser through Chromium, Firefox, and WebKit |
| pnpm SDK, node-gyp, or TLS setup | `just chainman run verify-sdk` | SDK identity, bundled node-gyp, and TLS trust with temporary certificates. This contacts npm |
| Android dependencies | `just verify-android-dependencies` | Resolves and stages frozen Robolectric SDKs |
| Android implementation or Cordova integration | `just verify-android` | Cordova Android 14/15 fixtures, Robolectric, lint, APK builds, and reinstallation |
| Android dependency failure handling | `just verify-android-failures` | Isolated missing, corrupt, and offline dependencies |
| iOS implementation or packaging | `just verify-ios` | Foundation fixtures and unsigned Cordova iOS 7/8 archives |
| Modern Apple profile | `just verify-ios-modern` | iOS builds and Foundation sanitizers using that profile |
| iOS native and real picker investigation | `just verify-ios-simulator` | Complete local iPhone/iPad and Cordova iOS 7/8 matrix |
| One required iOS partition | `just chainman run verify-ios-simulator-part cordova-ios7 iphone` | Controlled native cases and bridge smoke test for that partition |
| One iOS provider investigation | `just chainman run verify-ios-simulator-part cordova-ios7 iphone --investigation-only` | Real picker and provider UI cases for that partition |
| Capacitor Android integration | `just verify-capacitor-android` | Packed plugin through the Capacitor Android bridge on an emulator |
| Baseline Android and iOS together | `just verify-native` | Android and baseline iOS tasks on a host meeting both requirements |

For iOS partitions, choose `cordova-ios7` or `cordova-ios8` and `iphone` or `ipad`. `verify-native` excludes modern iOS, simulator, Capacitor emulator, and Android dependency-failure tasks. Simulator and emulator commands create virtual devices. `just clean` removes generated verification apps, reports, and Android fixture output.

## Automated coverage

The type lane uses TypeScript 5.7 and the pinned current compiler, including DOM compatibility for returned byte arrays. Browser tests exercise an installed plugin, managed URLs, failures, navigation, and CSP. Synthetic empty selections do not prove that a real OS dialog cancels correctly. Playwright WebKit is not a complete Safari or OS compatibility claim.

Android fixtures exercise production code through Cordova. Robolectric covers API 24, 28, 30, 33, and 35. The Capacitor 8.5.3 emulator lane uses a real bridge and provider reads at API 33 with controlled intent responses. It does not exercise a real system picker or cloud provider. There is no equivalent Capacitor iOS or Web lane.

The iOS Foundation fixtures cover I/O, limits, transaction recovery, and worker ownership. Archive builds cover both maintained Cordova iOS families and privacy-resource coexistence at the plugin's iOS 15 minimum. A successful build does not prove picker behavior on every supported OS or provider. The [known issue](KNOWN-ISSUES.md) describes observed Files stalls.

### File-reading comparison

For reading or resource-lifetime changes, compare equivalent content through managed streams, managed bytes, and the direct-data formats.

```sh
just chainman exec --profile toolchain -- node scripts/benchmark-files.mjs --output <path>
```

Choose an output path for the JSON report. This in-memory bridge fixture checks parity and cleanup and records chunk, payload, and modeled storage costs. Its timing is not native device throughput, and modeled copies are not measurements of filesystem writes or provider imports.

### Simulator and framework integration

Required CI runs nine controlled native picker tests and one Cordova bridge smoke case in each of four framework/device partitions, for 40 cases. The native fixtures present UIKit and call plugin commands without starting a WebView. The separate bridge case uses a fresh host process, `CDVViewController`, and `WKWebView`, waits for `deviceready`, and exercises restoration, reading, release, and a native error. Neither establishes real Files or provider UI behavior.

The manually dispatched [iOS picker investigation workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/ios-provider-investigation.yml) runs ten Chooser UI and ten independent UIKit control tests per partition, plus setup checks. Across four partitions that is 108 checks. Setup and assertions still gate the investigation. The complete local simulator suite combines the required 40 with those 108 checks.

Use `just chainman run diagnose-ios-simulator` for the baseline iPhone diagnostic. Variants add `-ipad`, `-modern`, or `-modern-ipad`. Append `--dismissal-only` or `--provider-only` for a narrower investigation. The [diagnostic workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/ios-simulator-diagnostic.yml) exposes corresponding profiles, devices, and scopes. Plain UIKit startup and gesture failures have also occurred in investigations, and their relationship to Files stalls is unproven.

Required qualification checks the exact case manifest, revision, package, and partitions. Diagnostic and investigation reports do not replace it. Preserve failed, timed-out, and unstarted cases rather than rerunning until green. Return provider UI cases to required CI only with evidence explaining the failure and fix, bounded validation on fresh simulators across affected partitions, and review of the exact required manifest.

### Stale-event guard checks

Run `just chainman run verify-ios-stale-events` or dispatch the [stale-event workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/ios-stale-events.yml) on public `master`. Three baseline cases must pass. Three disposable packages each disable one Photos, adaptive-presentation, or `cancelPick` identity guard. The corresponding test must fail at its named stale-event assertion. A timeout, compile error, missing test, or unrelated failure is not a detected regression. Each arm uses a fresh simulator. Its reports are diagnostic, not release qualification.

### Manual iOS release comparison

Run `just chainman run compare-ios-releases cordova-ios7 iphone` or dispatch the [release comparison workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/ios-release-comparison.yml). The default experiment compares the checksum-pinned RC1 package with the committed RC2 archive across four framework/device partitions. Each uses the same pinned Apple environment and a fresh simulator and provider store for each arm. The sequence is UIKit, RC1, RC2, RC2, RC1, UIKit. Retain all reports, including failures and unstarted cases. This investigation cannot qualify a release.

For more focused comparisons, the `metadata-mode`, `metadata-regression`, and `metadata-restoration` experiment arguments isolate picker mode or selected file/framework cases. For example.

```sh
just chainman run compare-ios-releases cordova-ios8 ipad metadata-mode
just chainman run compare-ios-releases cordova-ios7 ipad metadata-regression
just chainman run compare-ios-releases cordova-ios8 ipad metadata-restoration
```

The mode experiment uses Cordova iOS 8.x on iPad. Regression and restoration experiments target PNG with Cordova iOS 8.x on iPad and PDF with Cordova iOS 7.x on iPad. Experimental open-mode variants change the picker argument and record their patch and package identity. They do not establish a general workaround or replace qualification.

## Android dependency ownership

The Nix Android SDK supplies AAPT2 through `android.aapt2FromMavenOverride`, and Nix pins Gradle. Each Robolectric SDK has a separate resolvable configuration and locked, checksummed artifacts. `prepareRobolectricSdks` stages them for offline tests, which fail if the SDK is missing rather than silently downloading it.

Coordinate Robolectric, JDK, SDK, and instrumentation suffix changes in the [version catalog](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/android/gradle/libs.versions.toml) and [update configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/updates.toml). Resolve both Cordova Android fixture graphs and review locks and checksums together.

## Dependency updates

Policies and release-age rules live in [update configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/updates.toml) and [dependency configuration](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman/dependencies.toml). Validate and preview before applying a target.

```sh
just chainman config validate
just chainman deps-check
just chainman deps-coverage
just chainman deps-policy-report
just deps-update mode=dry-run targets=js
just deps-update targets=js
```

The [Dependency preview workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/dependency-preview.yml) offers `android`, `android-sdks`, and `capacitor` dry runs with structured output. Review the artifact and logs. Updates use isolated checkouts and normally commit after verification. Run relevant native lanes after updating. Use `targets=nix` for toolchain reconciliation, `targets=android` for both Android graphs, `targets=android-sdks` for SDK evidence, and `targets=capacitor` for the emulator graph. Preview each first.

For Capacitor updates, coordinate core, CLI, Android, policy constraints, Gradle adapter, and pnpm and Gradle graphs, then run the emulator lane. Review SDK, JDK, Gradle, and instrumentation compatibility. `just chainman deps-audit --targets js` checks available published advisories, and `just chainman chainman-update` updates the pinned Chainman runtime.

## CI and reports

The [Verify workflow](https://github.com/cyph/cordova-plugin-chooser/blob/master/.github/workflows/verify.yml) runs on pull requests, pushes to `master`, and manual dispatch. Its lanes must agree on the same revision and package. On public `master`, the signer checks the original portable archive's identity and bytes after required lanes agree and retains Sigstore bundles. CI does not publish npm packages.

Release evidence, archive, and bundles must come from the same workflow attempt. After rerunning selected jobs, use **Re-run all jobs** to regenerate complete evidence. Local reports are under `.verification/reports/`, and workflow artifacts retain failures. Setup failure means tests did not start, not that they passed. Integrity, lock, and assertion failures are not transient transport errors.

## Interactive checks

Use the [manual fixture app](https://github.com/cyph/cordova-plugin-chooser/tree/master/tests/fixture-app/www) and [native scenarios](https://github.com/cyph/cordova-plugin-chooser/blob/master/tests/native-cases.json) with disposable files. Exercise local and cloud providers, documents and Photos, cancellation, repeated calls, limits, empty and binary content, low storage, cache eviction, restoration, and release. Verify actual bytes as well as metadata. Include activity recreation, iOS presentation and orientation, and browser navigation for affected changes. For transaction or lifecycle work, test reset during blocked I/O and partial failures, including cleanup and original-file preservation.

## Release preparation

1. Align package and plugin versions, tag guidance, migration instructions, and the current changelog entry. Leave the date unset until publication is verified.
2. Run the required workflow for the candidate revision and archive, inspect every gate, perform relevant interactive checks, and retain the separate iOS investigation evidence. Describe unverified device and provider behavior in the release review.
3. Inspect the packed archive for documentation links, declarations, native resources, license, and notices. Requalify after any packaged change. The source-only plugin has no product build step. Its native builds qualify fixtures.
4. From a clean checkout of qualified public `master`, authenticate GitHub CLI and npm and run `just release-publish RUN_ID`. The wrapper packs committed source in staging. Chainman checks the workflow attempt, revision, jobs, signer, retained bundles, PURL, and digest before publishing the frozen archive with the configured `next` tag. Reports and bundles expire after 14 days.
5. Verify registry version, tag, timestamp, and integrity. Tag the qualified revision and record the verified UTC publication date and integrity in the GitHub release. Keep the published archive identical to the qualified artifact.
