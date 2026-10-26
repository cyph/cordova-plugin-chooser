"""Run one verification command with a deadline and an owned process group."""

import math
import os
import signal
import subprocess
import sys


def main(arguments):
    seconds = float(arguments[0])
    if not math.isfinite(seconds) or seconds <= 0 or len(arguments) < 2:
        raise ValueError("Expected a positive deadline and a command")
    child = None
    interrupted = None

    def signal_group(value):
        if child is not None:
            try:
                os.killpg(child.pid, value)
            except ProcessLookupError:
                pass

    def interrupt(value, _frame):
        nonlocal interrupted
        interrupted = value
        # A signal during Popen must not strand the child before assignment.
        if child is not None:
            signal_group(signal.SIGKILL)
            raise SystemExit(128 + value)

    for value in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(value, interrupt)

    status = 125
    try:
        # Output goes directly to the caller's bounded pipes. Keep this monitor
        # outside the command's session so it can terminate the entire group.
        child = subprocess.Popen(arguments[1:], start_new_session=True)
        if interrupted is not None:
            interrupt(interrupted, None)
        try:
            code = child.wait(timeout=seconds)
            status = code if code >= 0 else 128 - code
        except subprocess.TimeoutExpired:
            print(f"Verification command timed out after {seconds:g} seconds", file=sys.stderr)
            status = 124
    except OSError as error:
        print(f"Could not start verification command: {error}", file=sys.stderr)
        status = 127
    finally:
        if child is not None:
            try:
                if child.poll() is None:
                    signal_group(signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                # A parent may exit while descendants still hold output pipes.
                # Clean up the group even when the parent has already finished.
                signal_group(signal.SIGKILL)
                child.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired) as error:
                print(f"Verification process cleanup failed: {error}", file=sys.stderr)
                if status == 0:
                    status = 125
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
