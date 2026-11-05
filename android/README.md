# Drivo driver app (Android)

Kotlin with Jetpack Compose, MapLibre Android, Ferrostar for turn-by-turn navigation, FusedLocationProvider for GPS, Room for offline storage and WorkManager for sync. Built from Milestone 5.

The code will keep platform-neutral logic (sampling rules, fix filtering, batching, sync state) separate from Android APIs, so an iOS app (Swift, MapLibre iOS, Ferrostar iOS) can follow the same design.

Screens: Sign in, Today's run, Navigation, Arrived at stop, Proof of delivery, Drop a pin, Day ledger. Bottom tabs: Run, Map, Ledger, Drop pin, Account.
