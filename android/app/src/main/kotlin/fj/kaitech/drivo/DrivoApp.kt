package fj.kaitech.drivo

import android.app.Application
import fj.kaitech.drivo.data.DrivoDb
import fj.kaitech.drivo.data.DrivoRepository
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.realtime.Realtime
import io.github.jan.supabase.storage.Storage
import org.maplibre.android.MapLibre

class DrivoApp : Application() {
    lateinit var supabase: SupabaseClient
        private set
    lateinit var db: DrivoDb
        private set
    lateinit var repository: DrivoRepository
        private set

    override fun onCreate() {
        super.onCreate()
        MapLibre.getInstance(this)
        supabase = createSupabaseClient(BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_KEY) {
            install(Auth) {
                // Stay signed in on the driver's own phone until they sign out.
                alwaysAutoRefresh = true
                scheme = "fj.kaitech.drivo"
                host = "auth"
            }
            install(Postgrest)
            install(Realtime)
            install(Storage)
        }
        db = DrivoDb.create(this)
        repository = DrivoRepository(this, supabase, db.dao())
    }
}
