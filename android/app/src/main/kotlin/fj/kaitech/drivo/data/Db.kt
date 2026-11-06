package fj.kaitech.drivo.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/** A closed GPS batch waiting for upload. The id is made on the phone. */
@Entity(tableName = "queued_batches")
data class QueuedBatch(
    @PrimaryKey val id: String,
    val tenantId: String,
    val driverId: String,
    val vehicleId: String?,
    val recordedFrom: Long,
    val recordedTo: Long,
    val pointCount: Int,
    val pointsJson: String,
    val attempts: Int = 0,
)

/**
 * Work done offline, sent in order when there is signal:
 * kind = "upload" (a proof photo or signature file), "complete_stop", "arrive_stop", "submit_location".
 */
@Entity(tableName = "pending_actions")
data class PendingAction(
    @PrimaryKey val id: String,
    val kind: String,
    val payloadJson: String,
    val filePath: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val attempts: Int = 0,
    val lastError: String? = null,
)

/** Today's routes, saved at shift start so the run works with no signal. */
@Entity(tableName = "cached_routes")
data class CachedRoute(@PrimaryKey val id: String, val routeDate: String, val json: String, val savedAt: Long)

/** One line on the Day ledger. */
@Entity(tableName = "ledger")
data class LedgerEntry(
    @PrimaryKey val stopId: String,
    val routeId: String,
    val shopName: String,
    val reference: String?,
    val outcome: String,
    val receivedBy: String?,
    val cartons: Int,
    val completedAt: Long,
    val synced: Boolean,
)

@Dao
interface DrivoDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun queueBatch(b: QueuedBatch)
    @Query("select * from queued_batches order by recordedFrom limit :limit") suspend fun batches(limit: Int = 20): List<QueuedBatch>
    @Query("delete from queued_batches where id = :id") suspend fun deleteBatch(id: String)
    @Query("update queued_batches set attempts = attempts + 1 where id = :id") suspend fun batchFailed(id: String)
    @Query("select count(*) from queued_batches") fun batchCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun queueAction(a: PendingAction)
    @Query("select * from pending_actions order by createdAt") suspend fun actions(): List<PendingAction>
    @Query("delete from pending_actions where id = :id") suspend fun deleteAction(id: String)
    @Query("update pending_actions set attempts = attempts + 1, lastError = :error where id = :id") suspend fun actionFailed(id: String, error: String)
    @Query("select count(*) from pending_actions") fun actionCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveRoute(r: CachedRoute)
    @Query("select * from cached_routes where routeDate = :date") suspend fun routesFor(date: String): List<CachedRoute>
    @Query("delete from cached_routes where routeDate < :date") suspend fun pruneRoutes(date: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveLedger(e: LedgerEntry)
    @Query("update ledger set synced = 1 where stopId = :stopId") suspend fun markSynced(stopId: String)
    @Query("select * from ledger where completedAt >= :since order by completedAt desc") fun ledgerSince(since: Long): Flow<List<LedgerEntry>>
}

@Database(entities = [QueuedBatch::class, PendingAction::class, CachedRoute::class, LedgerEntry::class], version = 1, exportSchema = false)
abstract class DrivoDb : RoomDatabase() {
    abstract fun dao(): DrivoDao

    companion object {
        fun create(context: Context) = Room.databaseBuilder(context, DrivoDb::class.java, "drivo.db").build()
    }
}
