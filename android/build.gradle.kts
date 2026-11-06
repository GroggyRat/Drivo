// Android plugins are declared in app/build.gradle.kts, so :core builds on
// machines without the Android SDK or Google's Maven repository.
plugins {
    alias(libs.plugins.kotlin.jvm) apply false
}
