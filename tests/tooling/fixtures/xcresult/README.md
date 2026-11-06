These fixtures are derived from `xcresulttool get test-results` output from Xcode 26.3 (17C529). They retain the nested test-plan, bundle, suite, case, and failure-message structures and the original case identities and outcomes. Run identifiers, device metadata, timings, and fields unused by the validator were removed.

These inputs exercise the result parser. When changing the pinned Xcode or result-extraction commands, refresh them as needed from `xcresulttool` output, removing run-specific metadata and retaining coverage for failed, skipped, duplicate, missing, and renamed cases.
