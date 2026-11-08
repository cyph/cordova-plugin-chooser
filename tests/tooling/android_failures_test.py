"""Check that offline dependency evidence cannot pass with missing or shared artifacts."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/android-failures.py"
SPEC = importlib.util.spec_from_file_location("android_failures", SOURCE)
failures = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(failures)


class OfflineDependencyEvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="chooser-offline-evidence-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.home = self.directory / "gradle-home"
        self.home.mkdir()
        modules = ["androidx.activity:activity", "org.apache.cordova:framework",
                   "junit:junit", "org.robolectric:robolectric", "org.mockito:mockito-core"]
        artifacts = []
        for index, module in enumerate(modules):
            artifact = self.home / f"artifact-{index}.jar"
            artifact.write_bytes(b"fixture")
            artifacts.append({"module": module, "file": str(artifact)})
        self.report = {}
        for variant in ["debug", "release"]:
            for test in ["", "UnitTest"]:
                for scope in ["Compile", "Runtime", "AnnotationProcessor"]:
                    self.report[f"{variant}{test}{scope}Classpath"] = (
                        [] if scope == "AnnotationProcessor" else artifacts[:] if test else artifacts[:2]
                    )

    def test_complete_graphs_with_empty_processor_configurations_pass(self):
        failures.verify_offline_graphs(self.report, self.home)

    def test_each_test_graph_requires_its_own_test_dependencies(self):
        for name in ["debugUnitTestCompileClasspath", "debugUnitTestRuntimeClasspath",
                     "releaseUnitTestCompileClasspath", "releaseUnitTestRuntimeClasspath"]:
            with self.subTest(configuration=name):
                report = dict(self.report)
                report[name] = [artifact for artifact in report[name] if artifact["module"] != "junit:junit"]
                with self.assertRaisesRegex(AssertionError, "junit:junit"):
                    failures.verify_offline_graphs(report, self.home)

    def test_missing_configuration_cannot_hide_behind_other_graphs(self):
        del self.report["releaseRuntimeClasspath"]
        with self.assertRaisesRegex(AssertionError, "Missing offline classpaths"):
            failures.verify_offline_graphs(self.report, self.home)

    def test_cached_metadata_without_artifact_bytes_fails(self):
        Path(self.report["debugCompileClasspath"][0]["file"]).unlink()
        with self.assertRaisesRegex(AssertionError, "Missing offline artifact"):
            failures.verify_offline_graphs(self.report, self.home)

    def test_artifacts_from_another_cache_are_rejected(self):
        shared = self.directory / "shared.jar"
        shared.write_bytes(b"fixture")
        self.report["debugCompileClasspath"][0] = {
            "module": "androidx.activity:activity", "file": str(shared)
        }
        with self.assertRaisesRegex(AssertionError, "escaped isolated Gradle cache"):
            failures.verify_offline_graphs(self.report, self.home)

    def test_cold_environment_ignores_shared_read_only_cache(self):
        with patch.dict(os.environ, {"GRADLE_USER_HOME": "/previous-cache",
                                     "GRADLE_RO_DEP_CACHE": "/shared-cache",
                                     "ANDROID_HOME": "/pinned-sdk"}):
            env = failures.cache_environment(self.home)
            self.assertEqual(env["GRADLE_USER_HOME"], str(self.home))
            self.assertNotIn("GRADLE_RO_DEP_CACHE", env)
            self.assertEqual(env["ANDROID_HOME"], "/pinned-sdk")
            self.assertEqual(os.environ["GRADLE_RO_DEP_CACHE"], "/shared-cache")


if __name__ == "__main__":
    unittest.main()
