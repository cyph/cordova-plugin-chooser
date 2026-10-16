import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.tasks.Sync
import org.gradle.api.tasks.testing.Test
import org.gradle.api.tasks.testing.logging.TestExceptionFormat

// Robolectric's runtime resolver must consume the same verified Gradle artifacts.
val sdkCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")
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
    testLogging {
        events("failed")
        exceptionFormat = TestExceptionFormat.FULL
    }
    dependsOn(prepareRobolectricSdks)
    systemProperty("robolectric.offline", "true")
    systemProperty("robolectric.usePreinstrumentedJars", "true")
    systemProperty("robolectric.dependency.dir", sdkDirectory.get().asFile.absolutePath)
}
