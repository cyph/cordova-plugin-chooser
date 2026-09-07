# Contributing

Work from a repository checkout. Read the [API documentation](README.md) and [verification guide](docs/VERIFICATION.md) before changing bridge or native behavior.

Keep changes focused and explain the concrete behavior before/after. Preserve the Promise and callback overloads, single/array result shapes and cancellation resolving to `undefined`. New options should be additive. Keep TypeScript declarations and examples synchronized with the native and browser implementations.

Do not derive paths from provider names, grant arbitrary URI/path release, request broad storage permissions, or treat MIME/size metadata as validation. Keep metadata-only operations free of whole-file reads. Copy limits must use actual streamed bytes; errors and reset must release callback ownership and clean request-owned partial output. Document memory/storage costs and provider limitations.

Add regression cases at the contract or resource boundary. The current fixtures cover JavaScript, the browser proxy, native I/O helpers and Android provider/lifecycle behavior. UIKit, real browser gestures and genuine cloud/OS lifecycle behavior need their corresponding integration environments. State precisely which checks ran; do not report an authored test, a source inspection or a Foundation-only build as native platform verification.

For imported contributions, preserve authorship with `git cherry-pick -x` when practical. For adapted ports, identify the contributor and original immutable commit URL in the commit body, and describe the adaptations. Retain copyright/license notices. Source attribution is separate from claiming a fork's entire implementation is sound.

PR heads accepted for GitHub merge recognition must remain ancestors through genuine merge commits. Do not squash/rebase away accepted PR ancestry during upstream integration. Unaccepted PRs need explicit dispositions rather than cosmetic merge commits.

Version bumps, tagging, publication and upstream issue/PR updates belong to release preparation after verification.
