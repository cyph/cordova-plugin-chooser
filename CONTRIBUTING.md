# Contributing

Issues and pull requests are welcome. Before changing the public interface, read the [API reference](docs/API.md) and [platform guide](docs/PLATFORMS.md). For a bug report, follow the [reproduction checklist](docs/TROUBLESHOOTING.md#report-a-reproducible-issue).

## Development setup

Install Git, Nix with flakes enabled, and `just`, then run:

```sh
git clone --branch master https://github.com/cyph/cordova-plugin-chooser.git
cd cordova-plugin-chooser
just setup
just doctor
```

If `just` is not installed separately, use the flake-provided executable:

```sh
nix --extra-experimental-features 'nix-command flakes' run .#just -- setup
```

Chainman owns the toolchain, frozen dependencies, update policy, and verification tasks. Setup installs those dependencies and Git hooks. Repeat it after changing toolchain or dependency configuration. Use the [verification guide](docs/VERIFICATION.md) for host requirements and dependency updates rather than installing unpinned substitutes.

## Changes and review

Describe the problem, resulting behavior, and validation in your pull request. Add regression coverage at the public API, provider, or resource-ownership boundary affected by the change. Keep the JavaScript bridge, [TypeScript declarations](index.d.ts), native implementations, and documentation aligned.

RC2 picker methods are Promise-only and use options objects. Cancellation rejects with `CancellationError`; successful plural calls return nonempty arrays. Managed selection, metadata, and direct data have different memory and ownership behavior. Type declarations must work with TypeScript 5.7 and the pinned current compiler.

## Implementation boundaries

Keep provider and lifecycle behavior behind the shared contract. Preserve metadata paths that do not read complete contents, actual-byte budget enforcement, bounded bridge reads, and cleanup after partial failure. Provider names and supplied URIs must never determine cache paths.

Managed aliases share ownership by ID. Releasing an ID prevents new reads, stops unfinished plugin streams, waits for started reads and actual native I/O, and leaves source files alone. Cover stale callbacks, cancellation/reset races, failed deletion and retry, cache eviction, and concurrent reads when changing these paths.

Scoped helpers must preserve the consumer's original result or exception. Cleanup failure carries that outcome separately; it must not imply that a completed upload failed. Typed error codes are part of the API, while explanatory message wording is not.

Use the Cordova dispatcher or appropriate native fixtures to exercise integration boundaries. The [known iOS provider cases](docs/KNOWN-ISSUES.md) retain their assertions in a separate investigation workflow; do not broaden those exclusions to hide unrelated failures.

## Attribution and submission

Preserve authorship when importing work; use `git cherry-pick -x` where appropriate. For an adaptation, credit the contributor and link to the original commit. Retain copyright and license notices, and distinguish the original author's work from later modifications.

Develop against `master`. Run portable checks and native lanes relevant to the change, and report checks you could not run. Record public changes in the appropriate changelog entry without rewriting historical behavior or inventing publication dates. See [release preparation](docs/VERIFICATION.md#release-preparation) for package and release checks.
