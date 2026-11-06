package fj.kaitech.drivo.nav

import android.content.Context
import com.stadiamaps.ferrostar.core.AndroidSystemLocationProvider
import com.stadiamaps.ferrostar.core.AndroidTtsObserver
import com.stadiamaps.ferrostar.core.FerrostarCore
import com.stadiamaps.ferrostar.composeui.notification.DefaultForegroundNotificationBuilder
import com.stadiamaps.ferrostar.core.service.FerrostarForegroundServiceManager
import fj.kaitech.drivo.BuildConfig
import fj.kaitech.drivo.DrivoApp
import io.github.jan.supabase.auth.auth
import okhttp3.OkHttpClient
import uniffi.ferrostar.CourseFiltering
import uniffi.ferrostar.NavigationControllerConfig
import uniffi.ferrostar.RouteDeviationTracking
import uniffi.ferrostar.StepAdvanceMode
import uniffi.ferrostar.WaypointAdvanceMode
import java.net.URL
import java.time.Duration

/**
 * Turn-by-turn with Ferrostar and our own Valhalla. Routes come from
 * Drivo's backend (/api/navigation/route), which checks the driver's
 * sign-in and passes the request to the routing server; the routing key
 * never leaves the server. Ferrostar handles the turn banner, rerouting when
 * off route and spoken instructions (Android text-to-speech).
 *
 * Built against Ferrostar 0.30. Ferrostar's Android API still moves between
 * releases: check these constructor names when upgrading it.
 */
object Navigation {
    @Volatile private var core: FerrostarCore? = null
    @Volatile var tts: AndroidTtsObserver? = null
        private set

    fun core(context: Context): FerrostarCore = core ?: synchronized(this) {
        core ?: build(context.applicationContext).also { core = it }
    }

    private fun build(context: Context): FerrostarCore {
        val app = context as DrivoApp
        val http = OkHttpClient.Builder()
            .callTimeout(Duration.ofSeconds(30))
            .addInterceptor { chain ->
                val token = app.supabase.auth.currentSessionOrNull()?.accessToken
                chain.proceed(chain.request().newBuilder().apply { if (token != null) header("Authorization", "Bearer $token") }.build())
            }
            .build()
        val c = FerrostarCore(
            valhallaEndpointURL = URL("${BuildConfig.DRIVO_WEB_URL}/api/navigation/route"),
            profile = "truck",
            httpClient = http,
            locationProvider = AndroidSystemLocationProvider(context),
            foregroundServiceManager = FerrostarForegroundServiceManager(context, DefaultForegroundNotificationBuilder(context)),
            navigationControllerConfig = NavigationControllerConfig(
                WaypointAdvanceMode.WaypointWithinRange(50.0),
                StepAdvanceMode.RelativeLineStringDistance(minimumHorizontalAccuracy = 25U, specialAdvanceConditions = null),
                RouteDeviationTracking.StaticThreshold(minimumHorizontalAccuracy = 25U, maxAcceptableDeviation = 40.0),
                CourseFiltering.SNAP_TO_ROUTE,
            ),
        )
        val observer = AndroidTtsObserver(context)
        c.spokenInstructionObserver = observer
        tts = observer
        return c
    }
}
