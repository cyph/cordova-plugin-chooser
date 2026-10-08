# Development verification

Chainman owns project toolchains, frozen dependency installation, update policy and verification. Start from a checkout with Git, just and Nix (flakes enabled). These are host bootstrap prerequisites; do not install separate Node, pnpm, Java, Gradle or Playwright versions. The immutable runtime is selected by `chainman.lock`; no sibling chainman checkout is required.

```sh
just setup
just doctor
just verify
```

`setup` installs the frozen pnpm graph and Git hooks. Run it again after changing toolchain/configuration inputs. A stale setup stops tasks before commands start. CI explicitly performs setup; authorized unattended callers can instead set `CHAINMAN_SETUP=auto`. Ordinary verification never updates dependency locks.

## Lanes and their limits

| Command | Environment | Checks |
| --- | --- | --- |
| `just verify` | Linux, host Nix or Linux container Nix | JavaScript contracts, TypeScript declarations, package/source registration, packed artifact, Chromium/Firefox/WebKit integration |
| `just chainman run verify-portable` | Linux/macOS, host or container Nix | JavaScript, typings, source checks and packaging without browser binaries |
| `just verify-browser` | Linux, host/container Nix | Packed plugin installed in Cordova browser; three headless engines |
| `just verify-android` | Linux x86_64 or macOS, host Nix | Android 14/15 Robolectric/JUnit fixtures and disposable Cordova debug builds |
| `just verify-ios` | macOS, host Nix plus approved Xcode | Foundation fixtures and unsigned device-target Cordova iOS 7/8 builds |
| `just verify-native` | A host satisfying both native profiles | Both native lanes; fails preflight on an incompatible host |
| `just clean` | Project toolchain profile | Removes disposable apps and fixture build output |

The Nix flake supplies Node 24, pnpm, JDK 17, Gradle 8, Android SDK 35/36, CocoaPods and matching Playwright driver/browser binaries. `flake.lock` pins their package definitions, including each host’s Node patch. `chainman/tools.json` pins pnpm’s registry artifact and integrity across all hosts; its toolchain adapter reconciles `packageManager`. `chainman/node.json` declares the Node major family. Intel macOS uses the last Nixpkgs release supporting that architecture; its Node patch can differ from Linux/Apple Silicon while retaining Node 24. Browser lanes use pinned Mesa software rendering for headless hosts. The pnpm graph pins Cordova CLI and aliased platform releases within Android 14/15 and iOS 7/8. Hoisted linking accommodates platform scripts that Cordova copies into generated applications. No install scripts are approved in the dependency graph.

Apple's licensed SDK is an external host prerequisite. `chainman/apple.json` is the single owner of the selected Xcode version, build and iPhoneOS SDK. The iOS task selects its developer directory (or validates an explicitly supplied `DEVELOPER_DIR`) and fails on a mismatch. Upgrade this contract deliberately after qualifying both platform generations. The configured [macOS runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md) supplies that Xcode selection; hosted images can change, so the task verifies the actual tools.

Linux ARM can run the portable gate and resolve Java dependencies. Android's Linux build tools contain x86_64 executables, so the native build task fails explicitly on ARM. The Linux x86_64 CI job owns those executions. Neither native lane launches a simulator, emulator or device.

## What the fixtures establish

The JavaScript suite loads the production wrapper and browser proxy in isolated VM contexts. It checks preserved legacy arguments/callback overloads, exact binary/base64 bytes and padding, cancellation, duplicate settlement, malformed results, callback exceptions, arrays, limits, partial-resource rollback, ownership and page reset. The strict TypeScript fixture checks every method, callback form and cancellation union, including invalid calls using `@ts-expect-error`.

Each integration lane packs the plugin, checks required files and excluded development artifacts, extracts the tarball with Python's safe data filter, and installs that extracted artifact. Cordova's plugin engine inspection expects a directory. Platform packages come from the frozen pnpm graph rather than fresh registry ranges. The browser lane exercises the registered Cordova bridge in Chromium, Firefox and WebKit: real input selection and FileReader bytes, metadata/copy paths avoiding reads, empty files, multiple selection, BUSY, limits, read failure, Blob release and navigation cleanup. Removing/reinstalling the plugin also exercises installation bookkeeping. Empty automated selections do not establish native cancel-dialog behavior, and Playwright WebKit is not a complete Safari/OS integration claim.

Android fixtures compile the production sources in separate SDK 35/36 projects against Cordova framework 14/15. JUnit checks counted streams, limits, errors and cache ownership. Transaction fixtures check interruption, failed promotion/deletion, recovery, collisions, malformed journals and symlinks. Robolectric's API 28 provider double covers null/inaccurate metadata, sliced descriptors, cancellation, reset, restoration, concurrency and cleanup. Real `CordovaInterfaceImpl` regressions check reset while a picker is outstanding and restoration of an abandoned picker. Those tests establish dispatcher routing rather than merely calling plugin callbacks directly.

Foundation fixtures compile the actual iOS helpers in Swift 5 mode. They check streams, budgets, cancellation, ownership, transactions/recovery and coordinator cancellation. Worker fixtures block an abandoned read, demonstrate independent progress by the next request, and check capacity retention and exactly-once release. Foundation does not import UIKit/Cordova; the separate packed-plugin Cordova builds check those imports and source registration. A successful build does not establish live picker/provider behavior.

## Dependency maintenance

```sh
just chainman config validate
just chainman deps-check
just chainman deps-coverage
just chainman deps-policy-report
just deps-update mode=dry-run targets=js
just deps-update targets=js
```

Updates run in isolated checkouts and apply only declared outputs after the `verify` task succeeds. The portable gate includes the real-browser suite and requires a Linux execution environment; native acceptance is a separate CI requirement. Run the native lanes against the resulting branch before release. A portable update success alone is not a native compatibility claim.

Project dependencies have a 30-day maturity window. Nix input updates precede toolchain version reconciliation and package resolution. The `nix` target group also reconciles pnpm/Node and the JavaScript/native locks. JavaScript platform aliases remain inside their declared major families. The two Gradle adapters retain their Cordova framework generations and share a version catalog for fixture tooling. Actions have immutable SHAs and their own update adapter. The Apple SDK contract is explicitly maintained because chainman cannot redistribute or install Xcode.

Gradle fixtures use strict dependency locks and SHA-256 verification metadata. Their adapters resolve the complete configurations and update those files; test commands must never regenerate them. Native dependency updates require the Android profile but not an Apple SDK. An initial missing/unqualified native lock or registry/provider outage must be resolved through the adapter before a native lane can pass. Do not weaken strict verification to obtain a green result.

`just chainman deps-audit --targets js` checks published JavaScript vulnerability evidence, including development tools. Network auditing is separate from deterministic local tests; native ecosystem advisory coverage may be incomplete and must not be presented as a clean security scan. Runtime updates use `just chainman chainman-update`; normal setup/verification never advances `chainman.lock`.

The checked-in workflow runs these same commands with read-only repository permissions, pinned Actions, finite timeouts and unsigned iOS builds. It neither publishes packages nor deploys/signs applications. Dependency update dry-runs do not trigger Actions.

## Provider and operating-system integration

Use `tests/native-cases.json` and `tests/fixture-app/www` as scenario inputs in a disposable app. Manual checks remain for genuine cancel UI, cloud/download failures, revoked grants, rotation, process death, security-scoped access, swipe dismissal, orientation masks, filesystem exhaustion, OS eviction and browser back/forward-cache behavior. Include rapid reopen, blocking reads after reset, a second-file batch failure, partial writes and interruption around journal/promotion/commit. Hash source/copy bytes and inspect cache cleanup without using private user data as destructive fixtures.

Report each lane as passed, failed or not run, with its exact commit/environment. Keep execution reports in CI or the handoff conversation rather than accumulating dated reports in source docs. Preserve accepted PR head ancestry during upstream integration: GitHub's [indirect merge recognition](https://docs.github.com/en/pull-requests/reference/pull-request-merges#indirect-merges) requires those commits to reach the appropriate upstream base/default branch.
