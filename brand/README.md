# Drivo brand

The Drivo logo is a delivery route on a street map: the run starts at the blue dot, follows the street, and ends at the white pin.

| File | Use |
|---|---|
| `drivo-icon.svg` | App icon with streets, rounded square (sign-in page, large sizes) |
| `drivo-mark.svg` | Without the streets, for small sizes: browser tab, next to the name |
| `drivo-icon-square.svg` | Full-bleed square for iOS and the Apple touch icon (the system rounds the corners) |
| `drivo-icon-android-foreground.svg` | Android adaptive icon foreground (artwork inside the safe zone) |

Colours: navy `#0B1F44`, blue `#2563EB`, streets `#22396A` and `#2A4579`, white. Name set in IBM Plex Sans SemiBold.

After changing an SVG, regenerate every PNG (web, Android, iOS):

```bash
node brand/render-icons.cjs
```
