pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        maven("https://repo1.maven.org/maven2")
        google()
    }
}
rootProject.name = "drivo-android"

// Platform-neutral tracking logic, shared design with the future iOS app.
include(":core")

// The Android app needs the Android SDK. Builds without one (CI for :core,
// or machines without Android Studio) still build and test :core.
val hasSdk = System.getenv("ANDROID_HOME") != null ||
    System.getenv("ANDROID_SDK_ROOT") != null ||
    file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") }
if (hasSdk) include(":app") else println("Android SDK not found: building :core only")
