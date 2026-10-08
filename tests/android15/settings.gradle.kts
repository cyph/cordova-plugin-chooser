pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
    versionCatalogs { create("libs") { from(files("../android/gradle/libs.versions.toml")) } }
}
rootProject.name = "chooser-native-fixtures15"
