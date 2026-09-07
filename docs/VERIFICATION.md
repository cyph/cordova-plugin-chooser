# Development verification

Run these checks in a provisioned development environment and record the exact revision, toolchain and outcomes. Source inspection, host fixtures and native integration establish different things; report their results separately.

## JavaScript and declarations

From a repository checkout with a maintained Node.js version supporting `node:test` (Node 22+ is a suitable shared baseline):

```sh
npm test
```

The JavaScript suite has no third-party runtime dependencies. It loads the real wrapper/proxy in isolated VM contexts, supplies a Cordova bridge fixture and drives FileReader/DOM events. It covers legacy arguments, callback overloads and callback failures, cancellation, duplicate settlement, malformed responses, exact bytes and padding, multi-selection, metadata avoiding reads, copy limits, ownership, errors and page reset. DOM fixtures do not establish real-browser gesture or cancellation behavior.

For typings, provision the pinned development dependency first, then:

```sh
npm run test:types
```

The usage fixture checks all methods, Promise/callback cancellation unions, metadata without data fields and invalid calls using `@ts-expect-error`. Generate and review a package lock with the chosen npm version when establishing a reproducible CI environment; use `npm ci` thereafter.

## Android host fixtures

Prerequisites: JDK 17, Gradle compatible with AGP 8.10.1 (8.14.2 is a suitable baseline), Android SDK platforms 35/36, corresponding build tools, and dependency access/cache.

```sh
gradle -p tests/android -PcordovaVersion=14.0.0 -PcompileSdk=35 testDebugUnitTest
gradle -p tests/android -PcordovaVersion=15.0.0 -PcompileSdk=36 testDebugUnitTest
```

The library fixture compiles the production Java files. JUnit exercises exact streaming, limits, zero/short reads, cancellation, I/O failure and cache ownership. Robolectric drives the production plugin against a synthetic ContentProvider and Cordova interface for null/unknown metadata, failed selection/read, duplicate callbacks, busy state, state restoration, queued reset/release, multi-selection, launch failure and partial-file cleanup.

The Robolectric fixture uses API 28 for host behavior, while the two lanes compile against the platform generations' SDKs. This does not emulate Android 14/15 devices or prove behavior on API 24/35/36. Add API-level host variants only after these fixtures compile and their framework assumptions are reviewed. Do not replace failing assertions with implementation-shaped assertions simply to obtain a green lane.

## iOS Foundation fixtures

On a macOS host with Xcode command-line tools:

```sh
mkdir -p .verification
xcrun swiftc -swift-version 5 src/ios/ChooserError.swift src/ios/ChooserRequest.swift src/ios/ChooserFiles.swift tests/ios/main.swift -o .verification/chooser-foundation-fixtures
.verification/chooser-foundation-fixtures
```

These fixtures compile the actual Foundation/Darwin helper and exercise byte boundaries, unlimited/exact/exceeded limits, stream closure, cancellation, missing input, output failure, ID validation, symlink/directory rejection and source preservation. They do not import UIKit or Cordova and therefore cannot prove picker delegation, security-scoped provider behavior, presentation or plugin reset delivery. Partial-write handling has a source-reviewed loop; add a controlled short-write OutputStream double in the later native harness.

## Cordova installation and native builds

Create disposable applications outside the tracked source (for example under ignored `.verification/`). Record the exact Cordova CLI, platform patch versions, Node, Java, Gradle, Android SDK and Xcode/Swift versions. Use current patched releases within the selected 14.x/15.x and 7.x/8.x families when freezing release lanes; also exercise the minimum declared platform versions if retaining the current engine bounds.

For each Android generation, perform ordinary Cordova create/platform-add/plugin-add/prepare/build steps, using this checkout as the plugin source. Example from the repository root:

```sh
CHOOSER_ROOT="$PWD"
cordova create .verification/android14 com.cyph.chooser.fixture14 ChooserFixture
cd .verification/android14
cordova platform add android@14
cordova plugin add "$CHOOSER_ROOT"
cordova prepare android
cordova build android --debug
```

Repeat in a separate application for `android@15`. Inspect the generated native project: all Java sources and the `Chooser` feature must be registered, no storage/media permissions or largeHeap edit must be introduced by this plugin, and remove/re-add must not leave stale source entries. Build with each platform's standard settings, including target SDK. These are build-only lanes; no emulator/device launch is required.

On macOS, repeat with separate `ios@7` and `ios@8` applications. Cordova iOS 7 requires an SDK/toolchain capable of its iOS 11 deployment fallback; Cordova iOS 8 starts at iOS 13. See the [official platform requirements](https://cordova.apache.org/docs/en/latest/guide/platforms/ios/) and the [iOS 8 announcement](https://cordova.apache.org/announcements/2025/11/23/cordova-ios-8.0.0.html). Build a generic device target with signing disabled in the disposable project; do not provision signing accounts or deploy to a device. A typical Cordova command is:

```sh
cordova build ios --debug --device -- --buildFlag="CODE_SIGNING_ALLOWED=NO"
```

Record any required project-specific adjustment to that command. Check all Swift sources, the `@objc(Chooser)` registration, conditional Cordova imports, `.ok`/`.error` status names, iOS 14 availability guards, fallback UTIs and minimum deployment targets. Verify installation without the old Swift-support plugin. Do not count a Foundation-only build as this integration lane.

Reference Cordova's versioned [7.1.1 headers](https://github.com/apache/cordova-ios/tree/7.1.1/CordovaLib/include/Cordova) and [8.0.0 headers](https://github.com/apache/cordova-ios/tree/8.0.0/CordovaLib/include/Cordova), plus [Android 14 interface definitions](https://github.com/apache/cordova-android/blob/14.0.0/framework/src/org/apache/cordova/CordovaInterface.java). Check Swift imports and availability against every declared minimum platform version.

## Real-browser fixture

In a disposable Cordova browser app, install this checkout and replace the app's `www` files with `tests/fixture-app/www`. Prepare and serve the app through the Cordova browser workflow. The fixture uses the actual registered plugin and native file input, not the mocked DOM suite.

In current Chrome, Edge, Firefox and Safari, record observations for direct click activation, MIME hints, single/multiple selection, zero-byte files, native cancel events, repeated selection, concurrent requests, FileReader failure, Blob URL release, navigation and back/forward-cache return. Test metadata/copy modes with FileReader instrumentation to confirm that they do not invoke content reads. Browser Blob consumers should fail after release/navigation; a new selection should work afterward. Do not infer cross-browser behavior from one engine.

## Native lifecycle/provider scenarios

`tests/native-cases.json` is the shared scenario fixture; `tests/fixture-app/www` is the manual driver. The executable Android host tests and Foundation tests cover subsets, as described above. UIKit/file-provider, rotation, genuine process death, system cancellation UI, cloud access, filesystem exhaustion and OS eviction scenarios remain integration work. Real-device and emulator checks are separate from the host/build checks above.

In an integration environment, adapt the scenarios to its provider/test doubles. Include inaccurate metadata size, delayed/offline providers, blocking reads returning after reset, duplicate display names, second-file batch failure, partial output writes, revoked security-scoped access, swipe dismissal, app-restricted orientation masks, rapid reopen and outstanding-picker activity restoration. Hash source/copy bytes and inspect the dedicated cache before/after each failure. Never use real private user files as destructive fixtures.

## Packaging checks

Inspect `npm pack --dry-run` output and install the produced package into the disposable apps. Confirm `main`, `types`, `plugin.xml`, all native helpers, browser proxy, documentation and notices are shipped. The package must not include test build products or research downloads.

Preserve original PR ancestry during upstream integration. GitHub's [indirect merge behavior](https://docs.github.com/en/pull-requests/reference/pull-request-merges#indirect-merges) requires those commits to reach the appropriate upstream base/default branch.

Record each lane as **not run**, **failed** (with evidence), or **passed** (with exact revision/environment). No build, test or release badge should imply verification until the corresponding lane actually succeeds.
