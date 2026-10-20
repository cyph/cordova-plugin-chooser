import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.tasks.Sync
import org.gradle.api.tasks.testing.Test
import org.gradle.api.tasks.testing.logging.TestExceptionFormat

// Robolectric's runtime resolver must consume the same verified Gradle artifacts.
val sdkCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")
// AGP 8.x selects lint 31.x. Expose its otherwise detached tool graph to
// chainman's lock/checksum refresh without running Android executables.
val lintTool = configurations.create("chooserLint") {
    isCanBeResolved = true
    isCanBeConsumed = false
}
val agp = sdkCatalog.findVersion("agp").get().requiredVersion
check(agp.startsWith("8.")) { "Review lint dependency ownership when upgrading AGP" }
dependencies.add(lintTool.name, "com.android.tools.lint:lint-gradle:31.${agp.removePrefix("8.")}")
tasks.register("resolveVerificationDependencies") {
    doLast { check(lintTool.resolve().isNotEmpty()) }
}
// Each role needs a different version of the same module. Keep resolution separate.
val sdkInputs = listOf("runtime", "compile").map { role ->
    val dependency = sdkCatalog.findLibrary("robolectric-sdk-$role").get()
    val configuration = configurations.create("robolectric${role.replaceFirstChar { it.uppercase() }}Sdk") {
        isCanBeResolved = true
        isCanBeConsumed = false
        isTransitive = false
    }
    dependencies.addProvider(configuration.name, dependency)
    val declared = dependency.get()
    configuration to "${declared.module.name}-${declared.versionConstraint.requiredVersion}.jar"
}
val sdkDirectory = layout.buildDirectory.dir("robolectric-sdks")
val prepareRobolectricSdks = tasks.register<Sync>("prepareRobolectricSdks") {
    from(sdkInputs.map { it.first })
    into(sdkDirectory)
    doFirst {
        for ((configuration, expected) in sdkInputs) {
            check(configuration.singleFile.name == expected) {
                "Robolectric SDK resolution changed the declared artifact: $expected"
            }
        }
    }
}
tasks.withType<Test>().configureEach {
    // API 35's Robolectric descriptor shadow reflects over JDK FileDescriptor.
    jvmArgs("--add-opens=java.base/java.io=ALL-UNNAMED")
    testLogging {
        events("failed")
        exceptionFormat = TestExceptionFormat.FULL
    }
    if (name != "testMissingSdk") dependsOn(prepareRobolectricSdks)
    systemProperty("robolectric.offline", "true")
    systemProperty("robolectric.usePreinstrumentedJars", "true")
    systemProperty("robolectric.dependency.dir", sdkDirectory.get().asFile.absolutePath)
}

// Separate test tasks preserve evidence for each SDK and cannot reuse a test
// result from the other API level. Both consume the same frozen SDK directory.
afterEvaluate {
    val debugTests = tasks.named<Test>("testDebugUnitTest")
    for (api in listOf(28, 35)) {
        tasks.register<Test>("testApi$api") {
            dependsOn(provider { debugTests.get().taskDependencies.getDependencies(debugTests.get()) })
            testClassesDirs = debugTests.get().testClassesDirs
            classpath = debugTests.get().classpath
            systemProperty("robolectric.enabledSdks", api.toString())
            systemProperty("chooser.fixture.sdk", api.toString())
            reports.junitXml.outputLocation.set(layout.buildDirectory.dir("test-results/testApi$api"))
            reports.html.outputLocation.set(layout.buildDirectory.dir("reports/tests/testApi$api"))
        }
    }

    // Used only in isolated failure fixtures: skip preparation deliberately so a
    // deleted staged SDK must fail in Robolectric's offline resolver.
    tasks.register<Test>("testMissingSdk") {
        testClassesDirs = debugTests.get().testClassesDirs
        classpath = debugTests.get().classpath
        systemProperty("robolectric.enabledSdks", "28")
        systemProperty("chooser.fixture.sdk", "28")
        filter { includeTestsMatching("*.ChooserTest.metadataDoesNotOpenFilesAndUnknownSizeIsNull") }
    }
}
