plugins { alias(libs.plugins.android) }
apply(from = "artifacts.gradle.kts")
apply(from = "robolectric.gradle.kts")
android {
    namespace = "com.cyph.cordova.fixtures"
    compileSdk = 35
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("main").java.srcDirs("../../src/android")
    testOptions.unitTests.isIncludeAndroidResources = true
    lint {
        abortOnError = true
        warningsAsErrors = true
        htmlReport = true
        xmlReport = true
    }
}
androidComponents { beforeVariants { it.enableAndroidTest = false } }
dependencyLocking { lockAllConfigurations(); lockMode = LockMode.STRICT }
dependencies {
    implementation("org.apache.cordova:framework:14.0.0")
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.mockito)
}
