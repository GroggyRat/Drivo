package fj.kaitech.drivo.ui.screens

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import fj.kaitech.drivo.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.coroutines.resume

private val fiji = ZoneId.of("Pacific/Fiji")
fun timeOf(iso: String?): String = iso?.let { DateTimeFormatter.ofPattern("HH:mm").withZone(fiji).format(Instant.parse(it)) } ?: ""
fun timeOf(ms: Long): String = DateTimeFormatter.ofPattern("HH:mm").withZone(fiji).format(Instant.ofEpochMilli(ms))

/** One accurate fix for a proof of delivery or a dropped pin. */
@SuppressLint("MissingPermission")
suspend fun currentLocation(context: Context): Location? = suspendCancellableCoroutine { cont ->
    LocationServices.getFusedLocationProviderClient(context)
        .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
        .addOnSuccessListener { cont.resume(it) }
        .addOnFailureListener { cont.resume(null) }
}

/**
 * MapLibre map (MapProvider: style from BuildConfig.MAP_STYLE_URL, the Fiji
 * Protomaps style on Cloudflare R2 in production). Tiles seen at shift start
 * stay in MapLibre's offline cache for poor signal.
 */
@Composable
fun DrivoMap(modifier: Modifier, centre: LatLng, zoom: Double = 13.0, onReady: (MapLibreMap) -> Unit = {}) {
    AndroidView(modifier = modifier, factory = { ctx ->
        MapView(ctx).apply {
            onCreate(null)
            getMapAsync { map ->
                map.setStyle(BuildConfig.MAP_STYLE_URL) {
                    map.cameraPosition = CameraPosition.Builder().target(centre).zoom(zoom).build()
                    onReady(map)
                }
            }
            onStart()
            onResume()
        }
    })
}
