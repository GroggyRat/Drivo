plugins {
    id("com.android.application") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.1.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.0"
    id("com.google.devtools.ksp") version "2.1.0-1.0.29"
}

android {
    namespace = "fj.kaitech.drivo"
    compileSdk = 35

    defaultConfig {
        applicationId = "fj.kaitech.drivo"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Set in ~/.gradle/gradle.properties or CI secrets, never in the repository.
        buildConfigField("String", "SUPABASE_URL", "\"${project.findProperty("drivo.supabaseUrl") ?: "http://10.0.2.2:54321"}\"")
        buildConfigField("String", "SUPABASE_KEY", "\"${project.findProperty("drivo.supabaseKey") ?: ""}\"")
        buildConfigField("String", "DRIVO_WEB_URL", "\"${project.findProperty("drivo.webUrl") ?: "http://10.0.2.2:3000"}\"")
        buildConfigField("String", "MAP_STYLE_URL", "\"${project.findProperty("drivo.mapStyleUrl") ?: "https://tiles.openfreemap.org/styles/liberty"}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":core"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation("androidx.compose.ui:ui-text-google-fonts")
    implementation(libs.activity.compose)
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.service)
    implementation(libs.lifecycle.viewmodel.compose)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)

    implementation(libs.play.services.location)
    implementation(libs.maplibre.android)
    implementation(libs.ferrostar.core)
    implementation(libs.ferrostar.maplibreui)
    implementation(libs.ferrostar.composeui)

    implementation(platform(libs.supabase.bom))
    implementation(libs.supabase.auth)
    implementation(libs.supabase.postgrest)
    implementation(libs.supabase.realtime)
    implementation(libs.supabase.storage)
    implementation(libs.ktor.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.browser)
}
