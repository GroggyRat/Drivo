package fj.kaitech.drivo.tracking

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import fj.kaitech.drivo.DrivoApp
import fj.kaitech.drivo.MainActivity
import fj.kaitech.drivo.R
import fj.kaitech.drivo.core.geo.LngLat
import fj.kaitech.drivo.core.tracking.Batch
import fj.kaitech.drivo.core.tracking.Fix
import fj.kaitech.drivo.core.tracking.FixFilter
import fj.kaitech.drivo.core.tracking.PointBatcher
import fj.kaitech.drivo.core.tracking.SamplingPolicy
import fj.kaitech.drivo.core.tracking.SpeedLimits
import fj.kaitech.drivo.core.tracking.SpeedMonitor
import fj.kaitech.drivo.data.QueuedBatch
import fj.kaitech.drivo.sync.SyncWorker
import io.github.jan.supabase.realtime.RealtimeChannel
import io.github.jan.supabase.realtime.broadcast
import io.github.jan.supabase.realtime.channel
import io.github.jan.supabase.realtime.realtime
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant

/**
 * Foreground location service, running only while the driver is on shift.
 *
 *  - FusedLocationProvider at PRIORITY_HIGH_ACCURACY, every ~4 s moving and
 *    ~45 s when parked (SamplingPolicy).
 *  - Fixes worse than 30 m or with impossible jumps are dropped (FixFilter).
 *  - Live position is broadcast to the tenant's Realtime channel at most
 *    every 3 s; nothing is written per point.
 *  - Points are batched every ~45 s into Room, and SyncWorker uploads the
 *    batches when there is signal.
 */
class TrackingService : LifecycleService() {
    private val client by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private val repo get() = (application as DrivoApp).repository
    private val filter = FixFilter()
    private val sampling = SamplingPolicy()
    private val batcher = PointBatcher()
    private var speed = SpeedMonitor()
    private var limits: SpeedLimits? = null
    private var channel: RealtimeChannel? = null
    private var lastBroadcast = 0L
    private var vehicleId: String? = null

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach(::onLocation)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_STOP) {
            stopTracking()
            return START_NOT_STICKY
        }
        vehicleId = intent?.getStringExtra(EXTRA_VEHICLE) ?: vehicleId
        ServiceCompat.startForeground(this, 1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        TrackingState.update { it.copy(tracking = true) }
        requestUpdates()
        lifecycleScope.launch { prepare() }
        return START_STICKY
    }

    private suspend fun prepare() {
        val m = repo.membership ?: repo.loadMembership() ?: return
        repo.settings()?.let { s ->
            speed = SpeedMonitor(afterMs = s.alertAfterS * 1000L, toleranceKmh = s.toleranceKmh)
            limits = SpeedLimits(s.urbanLimit, s.highwayLimit, repo.speedZones().map { z ->
                SpeedLimits.Zone(z.name, z.limitKmh, (z.area["coordinates"]!!.jsonArray).map { poly ->
                    poly.jsonArray.map { ring -> ring.jsonArray.map { pt -> pt.jsonArray.let { LngLat(it[0].jsonPrimitive.doubleOrNull!!, it[1].jsonPrimitive.doubleOrNull!!) } } }
                })
            })
        }
        channel = repo.supabase.channel("tenant:${m.tenantId}").also { it.subscribe() }
    }

    @Suppress("MissingPermission")
    private fun requestUpdates() {
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, sampling.intervalMs)
            .setMinUpdateIntervalMillis(sampling.intervalMs / 2)
            .setWaitForAccurateLocation(true)
            .build()
        client.removeLocationUpdates(callback)
        client.requestLocationUpdates(request, callback, Looper.getMainLooper())
    }

    private fun onLocation(l: Location) {
        val fix = Fix(
            timeMs = l.time,
            lon = l.longitude,
            lat = l.latitude,
            accuracyM = if (l.hasAccuracy()) l.accuracy.toDouble() else 999.0,
            speedMps = if (l.hasSpeed()) l.speed.toDouble() else null,
            headingDeg = if (l.hasBearing()) l.bearing.toDouble() else null,
        )
        if (filter.accept(fix) !is FixFilter.Result.Kept) return
        if (sampling.onFix(fix)) requestUpdates()
        val limit = limits?.at(fix.position)
        val s = speed.onFix(fix, limit?.kmh)
        TrackingState.update { it.copy(lastFix = fix, speedKmh = s.speedKmh, limitKmh = s.limitKmh, overLimit = s.over, alert = s.alert) }
        batcher.add(fix)?.let(::queue)
        broadcast(fix, s.speedKmh)
    }

    private fun broadcast(fix: Fix, kmh: Int) {
        val ch = channel ?: return
        if (fix.timeMs - lastBroadcast < 3_000) return
        lastBroadcast = fix.timeMs
        val driver = repo.userId ?: return
        lifecycleScope.launch {
            runCatching {
                ch.broadcast("position", buildJsonObject {
                    put("driver_id", driver)
                    put("lon", fix.lon)
                    put("lat", fix.lat)
                    put("speed_kmh", kmh)
                    fix.headingDeg?.let { put("heading", it) }
                    put("at", Instant.ofEpochMilli(fix.timeMs).toString())
                })
            }
        }
    }

    private fun queue(batch: Batch) {
        val m = repo.membership ?: return
        val driver = repo.userId ?: return
        lifecycleScope.launch {
            repo.dao.queueBatch(QueuedBatch(
                id = batch.id,
                tenantId = m.tenantId,
                driverId = driver,
                vehicleId = vehicleId,
                recordedFrom = batch.recordedFrom,
                recordedTo = batch.recordedTo,
                pointCount = batch.points.size,
                pointsJson = JsonArray(batch.points.map { p -> JsonArray(p.toWire().map { JsonPrimitive(it) }) }).toString(),
            ))
            SyncWorker.enqueue(this@TrackingService)
        }
    }

    private fun stopTracking() {
        client.removeLocationUpdates(callback)
        batcher.flush()?.let(::queue)
        lifecycleScope.launch { channel?.unsubscribe() }
        TrackingState.update { TrackingState.Snapshot() }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.tracking_channel), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.tracking_title))
            .setContentText(getString(R.string.tracking_text))
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CHANNEL = "tracking"
        const val ACTION_STOP = "fj.kaitech.drivo.STOP_TRACKING"
        const val EXTRA_VEHICLE = "vehicle_id"

        fun start(context: Context, vehicleId: String?) {
            context.startForegroundService(Intent(context, TrackingService::class.java).putExtra(EXTRA_VEHICLE, vehicleId))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_STOP))
        }
    }
}
