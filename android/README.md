# Drivo driver app (Android)

Kotlin, Jetpack Compose, MapLibre Android, Ferrostar for turn-by-turn, FusedLocationProvider for GPS, Room for the offline queue and WorkManager for sync.

## Modules

| Module | What it holds | Builds without the Android SDK |
|---|---|---|
| `core` | Platform-neutral tracking logic: fix filtering (worse than 30 m, impossible jumps), adaptive sampling (4 s moving, 45 s parked), 45-second batches with phone-made ids, the speed readout rule, speed limits from town zones, the arrival geofence with "Not here yet", sync retry delays. Pure Kotlin, so the iOS app can follow the same rules. | Yes, with tests |
| `app` | The Android app: tracking foreground service, Room queue, SyncWorker, Supabase, Realtime broadcast, MapLibre and Ferrostar, and the screens | No |

`settings.gradle.kts` includes `:app` only when an Android SDK is found, so `:core` builds and tests anywhere.

## Screens

Bottom tabs on every screen: Run, Map, Ledger, Drop pin, Account.

1. **Sign in** with a KaiTech account, and an explanation of location sharing.
2. **Today's run**: summary, next stop card with Start navigation, Call and Arrived, all stops. Start route asks for location and notification permission. Without KaiWorkforce it also starts tracking.
3. **Navigation**: Ferrostar with our Valhalla. It shows the turn banner, route line, rerouting and voice with Mute, plus the speed readout beside the limit. The following stop appears faded underneath. A 50 m arrival geofence opens the next screen.
4. **Arrived**: "You are at <shop>", with "Check in and start delivery" and "Not here yet".
5. **Proof of delivery**: invoice lines, Delivered in full, photo, signature pad, Received by, and Report a problem or part delivery. Then Complete delivery.
6. **Drop a pin**: drag the map under the centre pin, then add a name, type, directions and photo. Submit sends it for review.
7. **Day ledger**: totals, then each delivery marked "Synced" or "Waiting to sync".
8. **Road alerts** (companies with the add-on): on Today's run and in Navigation, "Report on the road" for a hazard, police checkpoint or speed camera, and a warning with voice within 600 m of one, with "Still there" and "Not there". Alerts load while on shift and show on the Map tab.

## How tracking works

- `TrackingService` runs as a foreground service, and only during a shift. The shift starts either from a KaiWorkforce clock-in (broadcast on the tenant's channel) or, without KaiWorkforce, from starting a route. It ends at clock-out or the last stop.
- Fixes go through `core`: they are filtered, the sampling interval adapts, and they are collected into batches. Closed batches are stored in Room and uploaded by `SyncWorker` when there is signal. Each batch's id is made on the phone, so a retried upload is never stored twice.
- The live position is broadcast to `tenant:<id>` every 3 seconds. Nothing is written to the database per point.
- Deliveries, arrivals, pins and their photos are queued in Room and sent in order: files first, then the action that uses them. `complete_stop` is idempotent, so a retry after lost signal records the delivery once.
- Today's routes are saved at shift start. MapLibre keeps the tiles it has shown in its cache for areas with poor signal.

## Build

Needs Android Studio (or the Android SDK with platform 35) and JDK 17 or newer.

Set these in `~/.gradle/gradle.properties`, never in the repository:

```
drivo.supabaseUrl=https://<project>.supabase.co
drivo.supabaseKey=<publishable key>
drivo.webUrl=https://<admin web domain>
drivo.mapStyleUrl=https://<R2 bucket>/fiji/style.json
```

```bash
./gradlew :core:test :app:assembleDebug
```

Without those properties, the app points at a local Supabase and web app through the emulator (`10.0.2.2`).

## Status

- `:core` compiles and its 11 tests pass. They cover the 180 degree meridian on Taveuni, filtering, sampling, batching, the speed alert rule, speed limits and arrival.
- `:app` has **not been compiled yet**, because the build environment could not download the Android SDK or Google's Maven packages. Expect a first-build pass in Android Studio. The Ferrostar calls (`FerrostarCore`, `DefaultNavigationViewModel`, `DynamicallyOrientingNavigationView`) follow Ferrostar 0.30, and its Android API changes between releases.

## Single sign-on (planned)

Drivo keeps its own sign-in. "Continue as <name>" works through a Chrome Custom Tab on the KaiTech sign-in page (redirect `fj.kaitech.drivo://auth/callback`, already registered in the manifest). The tab shares the browser's KaiTech session, so a driver already signed in to KaiWorkforce on the web is not asked for a password. When KaiWorkforce gets a native app, Android AccountManager with a shared KaiTech account type, limited to apps signed with the KaiTech key, will hand Drivo a short-lived one-time code instead. See `docs/decisions.md`.

## Fonts

IBM Plex Sans (SIL Open Font License, `FONT-LICENSE-IBM-PLEX.txt`) is bundled in `app/src/main/res/font`.
