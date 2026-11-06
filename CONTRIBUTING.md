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

Setup uses the pinned Chainman runtime to install the frozen dependencies and Git hooks. Run it again after changing toolchain or dependency configuration. The [verification guide](docs/VERIFICATION.md) lists host requirements, test commands, and the supported dependency update workflow.

## Changes and review

Describe the problem, the behavior of the change, and how you tested it in your pull request. Add regression coverage at the public API, provider, or resource-ownership boundary affected by the change. Keep the JavaScript bridge, [TypeScript declarations](index.d.ts), native implementations, and documentation aligned.

Picker calls return Promises even when callbacks are supplied; cancellation resolves to `undefined`, and successful plural calls return nonempty arrays. Metadata, data, and URI methods have different memory and ownership behavior. Test the relevant contract when changing selection, copying, or release.

## Implementation boundaries

`Chooser` connects the bridge to the picker, while `ChooserRequest` manages requests and cancellation. File, budget, and transaction helpers manage I/O and cached copies. Changes to lifecycle or I/O need coverage for failures, cleanup, reset, and concurrent work as well as the successful path. Android picker ownership can outlast callback ownership after reset; on iOS, a started worker retains its lease until its I/O returns. Use the Cordova dispatcher or the relevant host fixtures to exercise these boundaries. Error messages are not stable typed error codes.

## Attribution and submission

Preserve authorship when importing work; use `git cherry-pick -x` when appropriate. For an adaptation, credit the contributor and link to the source commit. Keep copyright and license notices intact.

Run the portable checks and native lanes relevant to your change, and report any checks you could not run. Update the changelog for public changes. The [verification guide](docs/VERIFICATION.md#release-preparation) also covers release preparation.
