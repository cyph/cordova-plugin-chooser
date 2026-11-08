"""Test cold dependency preparation and frozen SDK failures in disposable caches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / ".verification/reports/android-failures"
LOCKS = ["gradle.lockfile", "buildscript-gradle.lockfile", "settings-gradle.lockfile", "gradle/verification-metadata.xml"]

# Independent of the preparation task: discover the ordinary AGP graphs only
# after project evaluation, and request their external artifacts in offline mode.
OFFLINE_PROBE = """\
import groovy.json.JsonOutput
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
allprojects { project ->
    tasks.register('verifyOfflineDependencies') {
        doLast {
            def result = [:]
            project.configurations.findAll {
                it.canBeResolved && (it.name.endsWith('CompileClasspath') ||
                    it.name.endsWith('RuntimeClasspath') || it.name.endsWith('AnnotationProcessorClasspath'))
            }.each { configuration ->
                result[configuration.name] = configuration.incoming.artifactView {
                    componentFilter { it instanceof ModuleComponentIdentifier }
                }.artifacts.artifacts.collect { artifact ->
                    def id = artifact.id.componentIdentifier
                    [module: "${id.group}:${id.module}".toString(), file: artifact.file.absolutePath]
                }
            }
            new File(System.getenv('CHOOSER_OFFLINE_DEPENDENCIES_REPORT')).text =
                JsonOutput.prettyPrint(JsonOutput.toJson(result))
        }
    }
}
"""


def cache_environment(home):
    env = dict(os.environ, GRADLE_USER_HOME=str(home))
    # A shared read-only cache would hide the missing-download regression.
    env.pop("GRADLE_RO_DEP_CACHE", None)
    return env


def verify_offline_graphs(report, home):
    expected = {f"{variant}{test}{scope}Classpath"
                for variant in ["debug", "release"] for test in ["", "UnitTest"]
                for scope in ["Compile", "Runtime", "AnnotationProcessor"]}
    assert expected <= report.keys(), f"Missing offline classpaths: {sorted(expected - report.keys())}"
    for name, artifacts in report.items():
        modules = {artifact["module"] for artifact in artifacts}
        if name in expected and not name.endswith("AnnotationProcessorClasspath"):
            required = {"androidx.activity:activity", "org.apache.cordova:framework"}
            if "UnitTest" in name:
                required |= {"junit:junit", "org.robolectric:robolectric", "org.mockito:mockito-core"}
            assert required <= modules, f"{name} did not resolve required modules: {sorted(required - modules)}"
        for artifact in artifacts:
            path = Path(artifact["file"])
            assert path.is_file(), f"Missing offline artifact: {path}"
            assert path.resolve().is_relative_to(home.resolve()), f"Artifact escaped isolated Gradle cache: {path}"


def fingerprint(root):
    return {f"{fixture}/{name}": hashlib.sha256((root / "tests" / fixture / name).read_bytes()).hexdigest()
            for fixture in ["android", "android15"] for name in LOCKS}


def verify_failure(result, patterns, causes=()):
    assert result.returncode != 0, "Failure injection unexpectedly passed"
    assert all(pattern.lower() in result.stdout.lower() for pattern in patterns), result.stdout[-5000:]
    assert not causes or any(cause.lower() in result.stdout.lower() for cause in causes), result.stdout[-5000:]


def main(preparation_only=False):
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
        probe = directory / "offline-dependencies.gradle"
        probe.write_text(OFFLINE_PROBE)
        sequence = 0

        def gradle(fixture, label, *arguments):
            nonlocal sequence
            sequence += 1
            aapt2 = Path(os.environ["ANDROID_HOME"]) / "build-tools" / ("35.0.0" if fixture == "android" else "36.0.0") / "aapt2"
            assert aapt2.is_file() and os.access(aapt2, os.X_OK), "Missing Nix-owned AAPT2"
            command = ["gradle", "--gradle-user-home", str(home), f"-Pandroid.aapt2FromMavenOverride={aapt2}", "--no-daemon", "--dependency-verification", "strict", "-p", str(checkout / "tests" / fixture), *arguments]
            result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, timeout=1200, check=False)
            (REPORTS / f"dependency-{sequence:02d}-{fixture}-{label}.log").write_text(result.stdout)
            assert fingerprint(checkout) == frozen, "Verification rewrote fixture locks/checksums"
            return result

        for fixture in ["android", "android15"]:
            home = directory / f"{fixture}-gradle-home"
            assert not home.exists(), "Preparation must start with an empty Gradle home"
            env = cache_environment(home)
            offline_report = REPORTS / f"{fixture}-offline-classpaths.json"
            offline_report.unlink(missing_ok=True)
            env["CHOOSER_OFFLINE_DEPENDENCIES_REPORT"] = str(offline_report)
            cold = gradle(fixture, "resolve", "prepareRobolectricSdks", "resolveVerificationDependencies")
            assert cold.returncode == 0, cold.stdout[-5000:]
            warm = gradle(fixture, "offline-classpaths", "--offline", "-I", str(probe), "prepareRobolectricSdks", "verifyOfflineDependencies")
            assert warm.returncode == 0, warm.stdout[-5000:]
            graphs = json.loads(offline_report.read_text())
            verify_offline_graphs(graphs, home)
            if preparation_only:
                print(f"{fixture}: empty-cache preparation and offline compile/runtime/test classpaths passed", flush=True)
                shutil.rmtree(home)
                continue
            sdk_files = sorted((home / "caches/modules-2/files-2.1/org.robolectric/android-all-instrumented").glob("9-*/**/*.jar"))
            assert len(sdk_files) == 1, f"Unexpected runtime SDK cache: {sdk_files}"
            jar = sdk_files[0]
            modules = home / "caches/modules-2"
            baseline = directory / "modules-baseline"
            shutil.copytree(modules, baseline)

            def restore_modules():
                shutil.rmtree(modules)
                shutil.copytree(baseline, modules)

            # Each injection starts with identical artifact metadata, avoiding a
            # previous missing-file result masking the checksum failure boundary.
            junit_files = {Path(artifact["file"]) for artifacts in graphs.values()
                           for artifact in artifacts if artifact["module"] == "junit:junit"}
            assert len(junit_files) == 1, f"Unexpected JUnit artifacts: {junit_files}"
            junit = junit_files.pop()
            try:
                junit.unlink()
                verify_failure(gradle(fixture, "missing-test-dependency", "--offline", "-I", str(probe), "verifyOfflineDependencies"), ["offline", junit.name])
            finally:
                restore_modules()
            try:
                with jar.open("r+b") as artifact:
                    artifact.write(b"CORRUPTED-SDK")
                verify_failure(gradle(fixture, "corrupt-cache", "--offline", "prepareRobolectricSdks", "--rerun-tasks"), ["verification failed", jar.name])
            finally:
                restore_modules()
            try:
                jar.unlink()
                verify_failure(gradle(fixture, "missing-cache", "--offline", "prepareRobolectricSdks"), ["offline", jar.name])
            finally:
                restore_modules()
                shutil.rmtree(baseline)
            good = gradle(fixture, "compile-tests", "--offline", "testApi28")
            assert good.returncode == 0, good.stdout[-5000:]
            staged = checkout / "tests" / fixture / "build/robolectric-sdks" / jar.name
            assert staged.is_file()
            staged.unlink()
            verify_failure(gradle(fixture, "missing-staged", "--offline", "testMissingSdk", "--rerun-tasks"), [jar.name], ["does not exist", "not a file"])
            assert not staged.exists(), "Missing SDK was silently repaired"
            print(f"{fixture}: cold preparation, offline classpaths/tests, missing cache, checksum corruption and offline resolver checks passed", flush=True)
            shutil.rmtree(home)
        assert fingerprint(ROOT) == primary, "Primary checkout metadata changed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preparation-only", action="store_true",
                        help="Check cold preparation and offline classpaths without compiling or running Android code")
    main(preparation_only=parser.parse_args().preparation_only)
