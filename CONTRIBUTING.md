# Contributing

Before changing behavior, read the [API reference](docs/API.md) and [platform guide](docs/PLATFORMS.md). For bug reports, use the [reproduction checklist](docs/TROUBLESHOOTING.md#report-a-reproducible-issue).

## Development setup

Start with Git, Nix with flakes enabled, and `just`:

```sh
git clone --branch master https://github.com/cyph/cordova-plugin-chooser.git
cd cordova-plugin-chooser
just setup
just doctor
```

Without a separate `just` installation, use the flake's package, for example:

```sh
nix --extra-experimental-features 'nix-command flakes' run .#just -- setup
```

Chainman selects toolchains and installs frozen dependencies and Git hooks. Its runtime is pinned by [chainman.lock](https://github.com/cyph/cordova-plugin-chooser/blob/master/chainman.lock); no sibling checkout is needed. Use the declared update workflow rather than refreshing locks with ad hoc package-manager commands. Re-run setup after toolchain or dependency configuration changes.

On Linux, `just verify` runs portable and browser checks. On macOS, use `just chainman run verify-portable` and the appropriate native task. See [verification and dependency maintenance](docs/VERIFICATION.md) for commands, host prerequisites, and update policy.

## Changes and review

Keep a contribution focused on a concrete behavior. Explain the trigger, resulting behavior, and validation in the pull request. Add regression coverage at the relevant public contract, provider, or resource-ownership boundary. Keep JavaScript, the [public declarations](index.d.ts), native implementations, and documentation consistent.

Preserve these contracts unless a change is explicitly intended and documented:

- Methods return Promises, including calls with optional callbacks; picker cancellation resolves to `undefined`.
- Successful plural methods return nonempty arrays; failed batches do not expose partial success.
- Metadata paths avoid complete-content reads in plugin code. Native copies use bounded I/O and count actual bytes for limits.
- Release operates only on plugin-owned resources. Failed batches attempt cleanup, and reset suppresses stale completions.
- Browser invocation preserves the user gesture, and managed URLs are released after failures and navigation.

## Implementation boundaries

`Chooser` integrates the bridge and picker; `ChooserRequest` owns request state and cancellation. File, budget, and transaction helpers handle I/O, limits, staging, promotion, and recovery. Keep slow provider work separate from cache housekeeping, and never recover a cache while another writer is active.

Android picker ownership can outlive callback ownership after reset. On iOS, a started worker retains its lease until I/O returns. Exercise these boundaries with the real Cordova dispatcher or relevant host fixtures when changing lifecycle code. The public error interface is currently text, not a stable typed schema.

## Attribution and submission

Preserve authorship for imported commits, using `git cherry-pick -x` when appropriate. For adapted work, name the contributor, link the immutable source commit, and explain the adaptation. Retain license and copyright notices. When integrating an accepted PR by local merge, preserve its original commits and ancestry so upstream GitHub can recognize the indirect merge.

Run the portable gate and relevant native lanes, stating any unexecuted checks. Update the changelog for public changes. Keep run-specific logs and results in CI or the pull request; documentation should explain usage and maintenance. See [release preparation](docs/VERIFICATION.md#release-preparation) for package qualification.
