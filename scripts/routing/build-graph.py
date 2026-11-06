#!/usr/bin/env python3
"""Builds Drivo's road graph for routing on Vercel (web/src/lib/routing/graph.ts).

Reads a Fiji OpenStreetMap extract and writes web/data/fiji-roads.bin: the
drivable roads as a graph whose nodes are junctions and dead ends, and whose
edges carry the road's length, speed, direction, name and shape.

Longitudes west of the 180 degree meridian (Taveuni's east side, the Lau
Group) are stored plus 360, so roads that cross the meridian join up and the
router never has to treat it specially. graph.ts converts back on output.

Usage (needs `pip install osmium`):
    python3 scripts/routing/build-graph.py fiji-latest.osm.pbf web/data/fiji-roads.bin

Format (little endian):
    "DRVG" magic, uint32 version, uint32 header length, header JSON (counts and
    names), then arrays, each 4-byte aligned:
      nodes      float32 [lon, lat] x nodeCount
      edgeFrom   uint32 x edgeCount
      edgeTo     uint32 x edgeCount
      edgeLen    float32 x edgeCount        metres
      edgeSpeed  uint8   x edgeCount        km/h
      edgeFlags  uint8   x edgeCount        1 = from->to allowed, 2 = to->from allowed
      edgeName   uint32  x edgeCount        index into names, 0 = no name
      edgeShape  uint32  x (edgeCount + 1)  offsets into shape points (CSR)
      shape      float32 [lon, lat] x shapeCount   points between from and to
"""
import json
import math
import struct
import sys

import osmium

# Typical truck speeds on Fiji roads, km/h. maxspeed tags, where present, cap these.
SPEEDS = {
    "motorway": 80, "trunk": 70, "primary": 60, "secondary": 50, "tertiary": 45,
    "motorway_link": 50, "trunk_link": 45, "primary_link": 40, "secondary_link": 35, "tertiary_link": 30,
    "unclassified": 35, "residential": 30, "living_street": 15, "service": 15, "road": 30, "track": 15,
}
EXCLUDED_SERVICE = {"parking_aisle", "drive-through", "emergency_access"}
NO_ACCESS = {"no", "private"}


def unwrap(lon):
    return lon + 360.0 if lon < 0 else lon


def metres(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(b[0] - a[0]) * math.cos(lat) * 6371008.8
    dy = math.radians(b[1] - a[1]) * 6371008.8
    return math.hypot(dx, dy)


def speed_of(tags, highway):
    speed = SPEEDS[highway]
    raw = tags.get("maxspeed", "")
    try:
        value = float(raw.split()[0])
        if "mph" in raw:
            value *= 1.609
        if 5 <= value <= 130:
            speed = min(speed, int(value * 0.9))
    except (ValueError, IndexError):
        pass
    return max(5, speed)


class Roads(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []  # (node ids, speed, flags, name)

    def way(self, w):
        tags = w.tags
        highway = tags.get("highway")
        if highway not in SPEEDS:
            return
        if highway == "service" and tags.get("service") in EXCLUDED_SERVICE:
            return
        if tags.get("access") in NO_ACCESS or tags.get("motor_vehicle") in NO_ACCESS or tags.get("motorcar") in NO_ACCESS:
            return
        if tags.get("area") == "yes":
            return
        oneway = tags.get("oneway", "")
        if highway in ("motorway", "motorway_link") or tags.get("junction") == "roundabout":
            oneway = oneway or "yes"
        flags = 3
        if oneway in ("yes", "1", "true"):
            flags = 1
        elif oneway == "-1":
            flags = 2
        name = tags.get("name") or tags.get("ref") or ""
        nodes = [n.ref for n in w.nodes]
        if len(nodes) >= 2:
            self.ways.append((nodes, speed_of(tags, highway), flags, name))


class Coords(osmium.SimpleHandler):
    def __init__(self, wanted):
        super().__init__()
        self.wanted = wanted
        self.coords = {}

    def node(self, n):
        if n.id in self.wanted:
            self.coords[n.id] = (unwrap(n.location.lon), n.location.lat)


def main(source, target):
    roads = Roads()
    roads.apply_file(source)
    uses = {}
    for nodes, *_ in roads.ways:
        for i, ref in enumerate(nodes):
            # Way ends count twice so they always become graph nodes.
            uses[ref] = uses.get(ref, 0) + (2 if i in (0, len(nodes) - 1) else 1)
    coords = Coords(uses.keys())
    coords.apply_file(source)
    xy = coords.coords

    # OpenStreetMap splits roads at the 180 degree meridian, with one node at
    # +180 and another at -180 for the same place. After unwrapping both sit at
    # 180, so join nodes there that share a latitude.
    at_meridian = {}
    canonical = {}
    for ref, (lon, lat) in xy.items():
        if abs(lon - 180.0) < 1e-6:
            key = round(lat, 6)
            canonical[ref] = at_meridian.setdefault(key, ref)
    joined = sum(1 for r, c in canonical.items() if r != c)
    if joined:
        for i, (refs, *rest) in enumerate(roads.ways):
            roads.ways[i] = ([canonical.get(r, r) for r in refs], *rest)
        uses = {}
        for refs, *_ in roads.ways:
            for i, ref in enumerate(refs):
                uses[ref] = uses.get(ref, 0) + (2 if i in (0, len(refs) - 1) else 1)
    print(f"joined {joined} road ends across the 180 degree meridian")

    junction_index = {}
    nodes_out = []
    names = [""]
    name_index = {"": 0}

    def junction(ref):
        if ref not in junction_index:
            junction_index[ref] = len(nodes_out)
            nodes_out.append(xy[ref])
        return junction_index[ref]

    e_from, e_to, e_len, e_speed, e_flags, e_name, e_shape, shape = [], [], [], [], [], [], [0], []
    for refs, speed, flags, name in roads.ways:
        refs = [r for r in refs if r in xy]
        if len(refs) < 2:
            continue
        if name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        start = 0
        length = 0.0
        between = []
        for i in range(1, len(refs)):
            length += metres(xy[refs[i - 1]], xy[refs[i]])
            if uses[refs[i]] > 1 or i == len(refs) - 1:
                a, b = junction(refs[start]), junction(refs[i])
                if a != b or between:
                    e_from.append(a); e_to.append(b); e_len.append(length)
                    e_speed.append(speed); e_flags.append(flags); e_name.append(name_index[name])
                    shape.extend(between)
                    e_shape.append(len(shape))
                start, length, between = i, 0.0, []
            else:
                between.append(xy[refs[i]])

    header = json.dumps({
        "nodeCount": len(nodes_out), "edgeCount": len(e_from), "shapeCount": len(shape), "names": names,
        "source": source.split("/")[-1],
    }).encode()

    def pad(buf):
        return buf + b"\0" * (-len(buf) % 4)

    with open(target, "wb") as f:
        f.write(pad(b"DRVG" + struct.pack("<II", 1, len(header)) + header))
        f.write(struct.pack(f"<{2 * len(nodes_out)}f", *[c for p in nodes_out for c in p]))
        f.write(struct.pack(f"<{len(e_from)}I", *e_from))
        f.write(struct.pack(f"<{len(e_to)}I", *e_to))
        f.write(struct.pack(f"<{len(e_len)}f", *e_len))
        f.write(pad(struct.pack(f"<{len(e_speed)}B", *e_speed)))
        f.write(pad(struct.pack(f"<{len(e_flags)}B", *e_flags)))
        f.write(struct.pack(f"<{len(e_name)}I", *e_name))
        f.write(struct.pack(f"<{len(e_shape)}I", *e_shape))
        f.write(struct.pack(f"<{2 * len(shape)}f", *[c for p in shape for c in p]))
    print(f"{len(nodes_out)} nodes, {len(e_from)} edges, {len(shape)} shape points, {len(names)} names -> {target}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
