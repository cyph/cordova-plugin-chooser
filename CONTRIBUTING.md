# Contributing

## Development setup

Start with a checkout, Git, Nix with flakes enabled, and `just`. Chainman selects toolchains and installs frozen dependencies:

```sh
just setup
just doctor
just verify
```

Do not install separate language tools or refresh locks with ad hoc package-manager commands. The immutable runtime comes from `chainman.lock`; a sibling checkout is unnecessary. See [verification and dependency maintenance](docs/VERIFICATION.md) for native prerequisites and update commands.

## Changes and tests

Keep changes focused on a concrete behavior. Explain the problem, resulting behavior and checks in the pull request. Add regression coverage at a public contract or resource boundary. Keep [API documentation](docs/API.md), TypeScript declarations and platform implementations synchronized.

Preserve Promise/callback overloads, single/array result shapes and cancellation resolving to `undefined`. Prefer additive options. Error messages currently have no stable machine-readable schema.

Run the portable gate for every change and relevant native lanes for native or dependency changes. A fixture test, source inspection and packed-app build establish different things; report checks accurately. Keep run-specific results in CI or the pull request. Project docs should explain usage and maintenance, without execution diaries, investigation dumps, machine-specific instructions or vulnerability reports.

## Implementation boundaries

- `Chooser` integrates the bridge and native picker. `ChooserRequest` owns request state and cancellation.
- `ChooserFiles` handles bounded I/O and cache ownership; `ChooserBudget` counts actual bytes. `ChooserTransaction` stages, promotes and recovers native batches.
- Keep provider I/O off the cache housekeeping queue. Recovery must not sweep active writers. Successful references belong to the caller until release or eviction.
- Keep metadata operations free of whole-file reads. Treat names, types and reported sizes as untrusted metadata. Generated filenames and opaque IDs constrain release to plugin-owned cache files.
- Android picker ownership can outlive callback ownership after reset; exercise the actual Cordova result dispatcher. iOS started workers retain their process-wide lease until I/O returns, even after callback invalidation.
- Preserve the browser's direct user gesture, exactly-once completion, and Blob cleanup after failures and navigation.

## Attribution and integration

Preserve authorship when importing changes, using `git cherry-pick -x` where appropriate. For adapted contributions, name the contributor, link the original immutable commit in the commit body, and explain the adaptation. Retain license and copyright notices.

When accepting a pull request through a local merge, preserve original commits and merge ancestry through upstream integration. Squashing or rebasing them away prevents GitHub from recognizing the indirect merge.

Release preparation includes required verification lanes, synchronizing package/plugin versions, reviewing the changelog and inspecting the packed artifact. Version changes, tags and publication should be deliberate release operations.
