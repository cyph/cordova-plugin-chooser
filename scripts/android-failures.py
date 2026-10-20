"""Test frozen SDK failure boundaries in disposable projects and Gradle caches."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / ".verification/reports/android-failures"
LOCKS = ["gradle.lockfile", "buildscript-gradle.lockfile", "settings-gradle.lockfile", "gradle/verification-metadata.xml"]


def fingerprint(root):
    return {f"{fixture}/{name}": hashlib.sha256((root / "tests" / fixture / name).read_bytes()).hexdigest()
            for fixture in ["android", "android15"] for name in LOCKS}


def verify_failure(result, patterns):
    assert result.returncode != 0, "Failure injection unexpectedly passed"
    assert all(pattern.lower() in result.stdout.lower() for pattern in patterns), result.stdout[-5000:]


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)
    primary = fingerprint(ROOT)
    with tempfile.TemporaryDirectory(prefix="chooser-dependency-failures-") as temporary:
        directory = Path(temporary)
        checkout = directory / "checkout"
        shutil.copytree(ROOT / "src", checkout / "src")
        for fixture in ["android", "android15"]:
            shutil.copytree(ROOT / "tests" / fixture, checkout / "tests" / fixture,
                            ignore=shutil.ignore_patterns("build", ".gradle", "local.properties"))
        frozen = fingerprint(checkout)
        home = directory / "gradle-home"
        env = dict(os.environ, GRADLE_USER_HOME=str(home))
        sequence = 0

        def gradle(fixture, label, *arguments):
            nonlocal sequence
            sequence += 1
            aapt2 = Path(os.environ["ANDROID_HOME"]) / "build-tools" / ("35.0.0" if fixture == "android" else "36.0.0") / "aapt2"
            assert aapt2.is_file() and os.access(aapt2, os.X_OK), "Missing Nix-owned AAPT2"
            command = ["gradle", f"-Pandroid.aapt2FromMavenOverride={aapt2}", "--no-daemon", "--dependency-verification", "strict", "-p", str(checkout / "tests" / fixture), *arguments]
            result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, timeout=1200, check=False)
            (REPORTS / f"dependency-{sequence:02d}-{fixture}-{label}.log").write_text(result.stdout)
            assert fingerprint(checkout) == frozen, "Verification rewrote fixture locks/checksums"
            return result

        for fixture in ["android", "android15"]:
            cold = gradle(fixture, "resolve", "prepareRobolectricSdks")
            assert cold.returncode == 0, cold.stdout[-5000:]
            warm = gradle(fixture, "warm", "--offline", "prepareRobolectricSdks")
            assert warm.returncode == 0, warm.stdout[-5000:]
            sdk_files = sorted((home / "caches/modules-2/files-2.1/org.robolectric/android-all-instrumented").glob("9-*/**/*.jar"))
            assert len(sdk_files) == 1, f"Unexpected runtime SDK cache: {sdk_files}"
            jar = sdk_files[0]
            original = directory / "original-sdk.jar"
            shutil.copy2(jar, original)
            try:
                jar.unlink()
                verify_failure(gradle(fixture, "missing-cache", "--offline", "prepareRobolectricSdks"), ["offline", "android-all-instrumented"])
                shutil.copy2(original, jar)
                with jar.open("r+b") as artifact:
                    artifact.write(b"CORRUPTED-SDK")
                verify_failure(gradle(fixture, "corrupt-cache", "--offline", "--refresh-dependencies", "prepareRobolectricSdks"), ["verification failed", "android-all-instrumented"])
            finally:
                shutil.copy2(original, jar)
            good = gradle(fixture, "compile-tests", "testApi28")
            assert good.returncode == 0, good.stdout[-5000:]
            staged = checkout / "tests" / fixture / "build/robolectric-sdks" / jar.name
            assert staged.is_file()
            staged.unlink()
            verify_failure(gradle(fixture, "missing-staged", "--offline", "testMissingSdk", "--rerun-tasks"), ["android-all-instrumented", "does not exist"])
            assert not staged.exists(), "Missing SDK was silently repaired"
            print(f"{fixture}: frozen resolution, missing cache, checksum corruption and offline resolver checks passed", flush=True)
        assert fingerprint(ROOT) == primary, "Primary checkout metadata changed"


if __name__ == "__main__":
    main()
