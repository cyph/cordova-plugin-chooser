plugins { alias(libs.plugins.android) }
apply(from = "../android/artifacts.gradle.kts")
android {
    namespace = "com.cyph.cordova.fixtures"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("main").java.srcDirs("../../src/android")
    sourceSets.getByName("main").manifest.srcFile("../android/src/main/AndroidManifest.xml")
    sourceSets.getByName("test").java.srcDirs("../android/src/test/java")
    testOptions.unitTests.isIncludeAndroidResources = true
}
androidComponents { beforeVariants { it.enableAndroidTest = false } }
dependencyLocking { lockAllConfigurations(); lockMode = LockMode.STRICT }
dependencies {
    implementation("org.apache.cordova:framework:15.0.0")
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.mockito)
}
