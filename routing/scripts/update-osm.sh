#!/usr/bin/env bash
# Downloads the latest Fiji OpenStreetMap extract from Geofabrik, checks it,
# and rebuilds the Valhalla tiles. Run once at install, then monthly
# (ops/drivo-osm-update.timer). Safe to re-run: the running server keeps
# serving the old tiles until the new build has finished.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="https://download.geofabrik.de/australia-oceania/fiji-latest.osm.pbf"
DIR="data/valhalla"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fsSL --retry 4 -o "$TMP/fiji.osm.pbf" "$URL"
curl -fsSL --retry 4 -o "$TMP/fiji.osm.pbf.md5" "$URL.md5"
expected="$(cut -d' ' -f1 "$TMP/fiji.osm.pbf.md5")"
actual="$(md5sum "$TMP/fiji.osm.pbf" | cut -d' ' -f1)"
if [[ "$expected" != "$actual" ]]; then
  echo "Checksum mismatch: expected $expected, got $actual" >&2
  exit 1
fi
size=$(stat -c %s "$TMP/fiji.osm.pbf")
if (( size < 5000000 )); then
  echo "Extract is only $size bytes; refusing to build from it" >&2
  exit 1
fi

if [[ -f "$DIR/fiji-latest.osm.pbf" ]] && cmp -s "$TMP/fiji.osm.pbf" "$DIR/fiji-latest.osm.pbf"; then
  echo "Extract unchanged; nothing to rebuild."
  exit 0
fi

mv "$TMP/fiji.osm.pbf" "$DIR/fiji-latest.osm.pbf"
date -u +%FT%TZ > "$DIR/osm-downloaded-at.txt"

echo "Rebuilding Valhalla tiles (a few minutes for Fiji)"
docker compose run --rm -e force_rebuild=True -e use_tiles_ignore_pbf=False -e serve_tiles=False valhalla
docker compose up -d --force-recreate valhalla vroom
echo "Done. Tiles built from the extract downloaded $(cat "$DIR/osm-downloaded-at.txt")."
