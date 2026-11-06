package fj.kaitech.drivo.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import fj.kaitech.drivo.DrivoApp
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.storage.storage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.parseToJsonElement
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Sends everything waiting on the phone when there is a connection: GPS
 * batches first, then proof files, then deliveries and pins in the order
 * they happened. Each item is removed only after the server accepted it.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as DrivoApp
        val repo = app.repository
        val dao = repo.dao
        if (repo.userId == null) return Result.success()
        var failed = false

        for (b in dao.batches(limit = 200)) {
            try {
                repo.supabase.from("gps_batches").insert(buildJsonObject {
                    put("id", b.id)
                    put("tenant_id", b.tenantId)
                    put("driver_id", b.driverId)
                    b.vehicleId?.let { put("vehicle_id", it) }
                    put("recorded_from", Instant.ofEpochMilli(b.recordedFrom).toString())
                    put("recorded_to", Instant.ofEpochMilli(b.recordedTo).toString())
                    put("point_count", b.pointCount)
                    put("points", Json.parseToJsonElement(b.pointsJson))
                })
                dao.deleteBatch(b.id)
            } catch (e: Exception) {
                // A retried upload that already arrived is a duplicate key: done.
                if (e.message?.contains("duplicate key") == true) dao.deleteBatch(b.id) else { dao.batchFailed(b.id); failed = true; break }
            }
        }

        for (a in dao.actions()) {
            try {
                val payload = Json.parseToJsonElement(a.payloadJson).jsonObject
                when (a.kind) {
                    "upload" -> {
                        val file = File(a.filePath!!)
                        if (file.exists()) {
                            repo.supabase.storage.from(payload.str("bucket")).upload(payload.str("path"), file.readBytes()) { upsert = true }
                        }
                    }
                    "complete_stop" -> {
                        repo.supabase.postgrest.rpc("complete_stop", payload)
                        dao.markSynced(payload.str("p_stop_id"))
                    }
                    "arrive_stop" -> repo.supabase.postgrest.rpc("arrive_stop", payload)
                    "submit_location" -> repo.supabase.postgrest.rpc("submit_location", payload)
                }
                dao.deleteAction(a.id)
            } catch (e: Exception) {
                dao.actionFailed(a.id, e.message ?: "error")
                failed = true
                // Keep order: a delivery must not be sent before its photo.
                break
            }
        }
        return if (failed) Result.retry() else Result.success()
    }

    private fun JsonObject.str(key: String) = this[key]!!.jsonPrimitive.content

    companion object {
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("drivo-sync", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
