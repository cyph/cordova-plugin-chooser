export CHAINMAN_MODE := env_var_or_default("CHAINMAN_MODE", "host-nix")

# Stable consumer bootstrap. Runtime behavior belongs to the pinned Git revision.
[group("Chainman")]
[positional-arguments]
chainman +args:
    #!/bin/sh
    set -eu
    IFS= read -r revision < chainman.lock
    case "$revision" in ''|*[!0-9a-f]*) echo 'chainman.lock requires a full lowercase Git SHA' >&2; exit 2 ;; esac
    test "${#revision}" -eq 40 && test "$(wc -c < chainman.lock)" -eq 41
    cache=${XDG_CACHE_HOME:-$HOME/.cache}/chainman/git/github.com-chainmandev-chainman/$revision.git
    g() (
        unset $(GIT_CONFIG_PARAMETERS='' GIT_CONFIG_COUNT=0 git rev-parse --local-env-vars)
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_TERMINAL_PROMPT=0 git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
    )
    if test ! -e "$cache"; then
        mkdir -p "${cache%/*}"
        temporary=$(mktemp -d "$cache.XXXXXX")
        g init --bare --quiet --template= "$temporary"
        ln -sn "$temporary" "$cache" 2>/dev/null || rm -rf "$temporary"
    fi
    if ! g --git-dir="$cache" cat-file -e "$revision" 2>/dev/null; then
        g --git-dir="$cache" -c gc.auto=0 fetch --no-auto-maintenance --no-write-fetch-head https://github.com/chainmandev/chainman.git "$revision"
    fi
    g --git-dir="$cache" fsck --full --strict --no-reflogs --no-dangling
    test "$(g --git-dir="$cache" cat-file -t "$revision")" = commit
    entry=$(g --git-dir="$cache" cat-file blob "$revision:bootstrap/git-entry.sh")
    exec sh -c "$entry" chainman "$PWD" "$cache" "$revision" "$@"

[positional-arguments]
setup *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman setup "$@"

[positional-arguments]
verify *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman recipe verify "$@"

[positional-arguments]
verify-native *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman run verify-native "$@"

[positional-arguments]
verify-android *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman run verify-android "$@"

[positional-arguments]
verify-ios *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman run verify-ios "$@"

[positional-arguments]
verify-browser *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman run verify-browser "$@"

[positional-arguments]
doctor *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman doctor "$@"

[positional-arguments]
deps-update *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman deps-update "$@"

[positional-arguments]
clean *args:
    #!/bin/sh
    exec {{quote(just_executable())}} chainman clean "$@"
