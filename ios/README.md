# Drivo driver app (iOS)

SwiftUI, MapLibre iOS, Ferrostar iOS for turn-by-turn, Core Location for tracking, supabase-swift. Same screens and rules as the Android app.

| Part | What it holds |
|---|---|
| `DrivoCore/` | Swift package with the tracking rules, ported from `android/core`: fix filtering (worse than 30 m, impossible jumps), adaptive sampling (4 s moving, 45 s parked), 45-second batches with phone-made ids, the speed readout rule, speed limits from town zones, the arrival geofence with "Not here yet". Same tests as Android. No UIKit, so `swift test` runs on any Mac. |
| `Drivo/` | The app: tracking with background location, offline store and sync, Realtime broadcast, Ferrostar navigation with voice and mute, arrival, proof of delivery with photo and signature, drop a pin, day ledger, account |
| `project.yml` | XcodeGen spec (the Xcode project is generated, not committed) |

## Build on a Mac

Needs Xcode 16 and an Apple Developer account to run on a phone.

```bash
brew install xcodegen
```

```bash
cd ios && xcodegen generate && open Drivo.xcodeproj
```

Create `ios/Config.local.xcconfig` (not committed) with your project's values. In xcconfig files, write `//` in URLs as `/$()/`:

```
DRIVO_SUPABASE_URL = https:/$()/<project>.supabase.co
DRIVO_SUPABASE_KEY = <publishable key>
DRIVO_WEB_URL = https:/$()/<admin web domain>
DRIVO_MAP_STYLE_URL = https:/$()/<R2 bucket>/fiji/style.json
```

Pick your team under Signing & Capabilities, choose a phone, and Run. For testers, archive and upload to TestFlight.

Tracking rules on their own:

```bash
cd ios/DrivoCore && swift test
```

## How tracking works on iOS

- Core Location at best-for-navigation accuracy with background location updates (`UIBackgroundModes: location`). The blue indicator shows while tracking. iPhone asks for While Using first, then Always, which the sign-in screen explains.
- Tracking runs only on shift: KaiWorkforce clock-in and clock-out arrive on the tenant's Realtime channel. Without KaiWorkforce, tracking runs from starting the route to the last stop.
- iOS has no fixed update interval, so DrivoCore keeps one fix about every 4 s moving and 45 s parked, and the distance filter widens when parked.
- Batches, deliveries, pins and photos are saved in Application Support and sent in order when there is a connection (network monitor, retries, and a background task when the app is closed).

## Status

Written, but not compiled here: the build environment is Linux. The `iOS` GitHub Actions workflow runs `swift test` for DrivoCore and builds the app for the Simulator on a macOS runner; check that run for the first real compile. Expect first-build fixes, especially around Ferrostar and MapLibre SwiftUI, whose APIs still change between releases.
