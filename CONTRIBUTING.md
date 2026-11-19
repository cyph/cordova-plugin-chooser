# Contributing

Bug reports and pull requests are welcome. For a report, collect the information in the [troubleshooting checklist](docs/TROUBLESHOOTING.md#report-a-reproducible-issue). For a change, describe the observed problem, the resulting behavior, and the checks you ran.

## Development setup

Install Git, Nix with flakes enabled, and `just`. From a checkout of `master`, run.

```sh
just setup
just doctor
```

If `just` is not installed, the flake can provide it.

```sh
nix --extra-experimental-features 'nix-command flakes' run .#just -- setup
```

Setup installs the project's pinned dependencies and Git hooks. Run it again after changing toolchain or dependency configuration. The [verification guide](docs/VERIFICATION.md) maps changes to checks and lists host requirements. Use the pinned environment rather than substituting unpinned tools.

The shipped JavaScript is compiled from strict TypeScript. Edit its source in `typescript/` and run `npm run build:runtime` to regenerate the files loaded by Cordova and Capacitor. Include the generated files in the same commit. The portable checks verify that the compiler produces identical files.

## Changes and review

Keep the JavaScript bridge, [declarations](index.d.ts), native implementations, and user documentation consistent. Add regression coverage at the boundary affected by a behavior change. Test type changes with both the minimum TypeScript version and the pinned current compiler. Check both Capacitor and Cordova when changing installation, bridge behavior, or shared APIs. Test the typed Capacitor import and the Cordova global from the packed archive.

The public RC2 contract is Promise-based and uses options objects. Picker cancellation rejects, while successful plural selection is nonempty. Metadata, complete data, and managed handles have different resource and memory costs. Use [API reference](docs/API.md) and [platform guide](docs/PLATFORMS.md) as the shared contract when reviewing changes.

## Implementation boundaries

Preserve actual-byte budget enforcement, bounded bridge reads, and cleanup of partial failures. Provider-supplied names and URIs must not determine cache paths. Metadata paths must not read complete contents in plugin code merely to report metadata.

Managed handles share ownership by ID. Release blocks new reads, stops unfinished streams, waits for started reads and native I/O, and must leave the source intact. Exercise stale callbacks, reset and cancellation races, deletion failure and retry, cache eviction, and concurrent reads when changing lifetime code. A scoped helper must retain the consumer's outcome even if cleanup fails, so an app can distinguish a completed upload from a failed one.

Use the dispatcher or relevant native fixtures for integration changes. The separate iOS provider investigation retains its assertions. Do not broaden exclusions to hide unrelated failures. Document what you could not test and retain failed investigation evidence.

## Attribution and submission

Preserve existing copyright and license notices. Credit the original contributor and link the original commit when adapting work from elsewhere. Use `git cherry-pick -x` when appropriate and distinguish later modifications from the original contribution.

Develop against `master`, run checks appropriate to the changed boundary, and include their results in the pull request. Record public changes in the current changelog entry without altering earlier history or inventing a publication date. Release qualification and package checks are described in [release preparation](docs/VERIFICATION.md#release-preparation).
