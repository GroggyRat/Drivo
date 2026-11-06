import { readFileSync } from "node:fs";
import path from "node:path";
import type { LngLat } from "@/lib/geo";

// Drivo's own road router, small enough to run inside a Vercel function.
// The graph (web/data/fiji-roads.bin) is built from the Fiji OpenStreetMap
// extract by scripts/routing/build-graph.py: junctions as nodes, roads
// between them as edges with length, speed, direction, name and shape.
// Longitudes west of 180 degrees are stored plus 360 so roads across the
// meridian join up; everything leaving this module is back in -180..180.

export type Weight = "time" | "distance" | "fuel";

/** Where a point meets the road network: on edge `edge`, `along` metres from its start. */
export type Snap = { edge: number; along: number; point: LngLat; offRoadM: number };

/** One edge travelled, from `fromM` to `toM` metres along it (forward when fromM < toM). */
export type PathPart = { edge: number; fromM: number; toM: number };

export type Path = { parts: PathPart[]; distanceM: number; durationS: number; cost: number };

const R = 6_371_008.8;
const RAD = Math.PI / 180;
const CELL = 0.02; // degrees, for the snapping grid

const unwrap = (lon: number) => (lon < 0 ? lon + 360 : lon);
export const wrap = (lon: number) => (lon > 180 ? lon - 360 : lon);

function metres(a: LngLat, b: LngLat) {
  const lat = ((a[1] + b[1]) / 2) * RAD;
  return Math.hypot((b[0] - a[0]) * RAD * Math.cos(lat) * R, (b[1] - a[1]) * RAD * R);
}

export class RoadGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly names: string[];
  private nodes: Float32Array;
  private eFrom: Uint32Array;
  private eTo: Uint32Array;
  readonly eLen: Float32Array;
  readonly eSpeed: Uint8Array;
  private eFlags: Uint8Array;
  private eName: Uint32Array;
  private eShape: Uint32Array;
  private shape: Float32Array;
  // Outgoing half-edges per node (CSR): edge index, and +1 forward / -1 backward.
  private outStart: Uint32Array;
  private outEdge: Uint32Array;
  private outDir: Int8Array;
  private grid = new Map<string, number[]>();
  /** Roads meeting at each node, whatever their direction. */
  private roadsAt: Uint16Array;

  constructor(buffer: Buffer) {
    if (buffer.toString("ascii", 0, 4) !== "DRVG") throw new Error("Not a Drivo road graph");
    const headerLen = buffer.readUInt32LE(8);
    const header = JSON.parse(buffer.toString("utf8", 12, 12 + headerLen)) as { nodeCount: number; edgeCount: number; shapeCount: number; names: string[] };
    this.nodeCount = header.nodeCount;
    this.edgeCount = header.edgeCount;
    this.names = header.names;
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    let offset = 12 + headerLen;
    offset += -offset & 3;
    const take = <T>(make: (b: ArrayBuffer, o: number, n: number) => T, count: number, bytes: number) => {
      const view = make(ab, offset, count);
      offset += count * bytes;
      offset += -offset & 3;
      return view;
    };
    const E = header.edgeCount;
    this.nodes = take((b, o, n) => new Float32Array(b, o, n), header.nodeCount * 2, 4);
    this.eFrom = take((b, o, n) => new Uint32Array(b, o, n), E, 4);
    this.eTo = take((b, o, n) => new Uint32Array(b, o, n), E, 4);
    this.eLen = take((b, o, n) => new Float32Array(b, o, n), E, 4);
    this.eSpeed = take((b, o, n) => new Uint8Array(b, o, n), E, 1);
    this.eFlags = take((b, o, n) => new Uint8Array(b, o, n), E, 1);
    this.eName = take((b, o, n) => new Uint32Array(b, o, n), E, 4);
    this.eShape = take((b, o, n) => new Uint32Array(b, o, n), E + 1, 4);
    this.shape = take((b, o, n) => new Float32Array(b, o, n), header.shapeCount * 2, 4);

    const degree = new Uint32Array(this.nodeCount + 1);
    for (let e = 0; e < E; e++) {
      if (this.eFlags[e] & 1) degree[this.eFrom[e] + 1]++;
      if (this.eFlags[e] & 2) degree[this.eTo[e] + 1]++;
    }
    for (let i = 0; i < this.nodeCount; i++) degree[i + 1] += degree[i];
    this.outStart = degree;
    this.outEdge = new Uint32Array(degree[this.nodeCount]);
    this.outDir = new Int8Array(degree[this.nodeCount]);
    const fill = degree.slice(0, this.nodeCount);
    for (let e = 0; e < E; e++) {
      if (this.eFlags[e] & 1) { const k = fill[this.eFrom[e]]++; this.outEdge[k] = e; this.outDir[k] = 1; }
      if (this.eFlags[e] & 2) { const k = fill[this.eTo[e]]++; this.outEdge[k] = e; this.outDir[k] = -1; }
    }

    this.roadsAt = new Uint16Array(this.nodeCount);
    for (let e = 0; e < E; e++) { this.roadsAt[this.eFrom[e]]++; this.roadsAt[this.eTo[e]]++; }

    for (let e = 0; e < E; e++) {
      const pts = this.edgePoints(e);
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
          for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
            const key = `${x}:${y}`;
            const list = this.grid.get(key);
            if (list) { if (list[list.length - 1] !== e) list.push(e); } else this.grid.set(key, [e]);
          }
        }
      }
    }
  }

  private node(i: number): LngLat {
    return [this.nodes[i * 2], this.nodes[i * 2 + 1]];
  }

  /** The edge's points from its start node to its end node (unwrapped longitudes). */
  edgePoints(e: number): LngLat[] {
    const pts: LngLat[] = [this.node(this.eFrom[e])];
    for (let k = this.eShape[e]; k < this.eShape[e + 1]; k++) pts.push([this.shape[k * 2], this.shape[k * 2 + 1]]);
    pts.push(this.node(this.eTo[e]));
    return pts;
  }

  /** How many roads meet where a path part ends (2 means the road just carries on). */
  roadsAtEnd(part: PathPart) {
    return this.roadsAt[part.toM >= part.fromM ? this.eTo[part.edge] : this.eFrom[part.edge]];
  }

  edgeName(e: number) {
    return this.names[this.eName[e]] ?? "";
  }

  edgeSeconds(e: number, metresAlong = this.eLen[e]) {
    return metresAlong / (this.eSpeed[e] / 3.6);
  }

  /** Nearest point on a drivable road, within `maxM` metres. */
  snap(position: LngLat, maxM = 2000): Snap | null {
    const p: LngLat = [unwrap(position[0]), position[1]];
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    let best = null as Snap | null;
    const reach = Math.ceil(maxM / 1000 / (CELL * 111)) + 1;
    for (let ring = 0; ring <= reach; ring++) {
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          for (const e of this.grid.get(`${x}:${y}`) ?? []) {
            const pts = this.edgePoints(e);
            let along = 0;
            for (let i = 1; i < pts.length; i++) {
              const [a, b] = [pts[i - 1], pts[i]];
              const seg = metres(a, b);
              const kx = Math.cos(p[1] * RAD);
              const dx = (b[0] - a[0]) * kx, dy = b[1] - a[1];
              const len2 = dx * dx + dy * dy;
              const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (((p[0] - a[0]) * kx) * dx + (p[1] - a[1]) * dy) / len2));
              const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
              const d = metres(p, q);
              if (!best || d < best.offRoadM) best = { edge: e, along: along + seg * t, point: q, offRoadM: d };
              along += seg;
            }
          }
        }
      }
      // A ring further out can only be closer if the best so far is beyond this ring's inner edge.
      if (best && (best as Snap).offRoadM < ring * CELL * 111_000 * Math.cos(p[1] * RAD)) break;
    }
    const found = best as Snap | null;
    if (!found || found.offRoadM > maxM) return null;
    // Scale the along distance from the shape's measured length to the stored edge length.
    const shapeLen = this.edgePoints(found.edge).reduce((sum, q, i, pts) => (i ? sum + metres(pts[i - 1], q) : 0), 0);
    if (shapeLen > 0) found.along *= this.eLen[found.edge] / shapeLen;
    return found;
  }

  private cost(e: number, metresAlong: number, weight: Weight, litresPer100Km: number) {
    if (weight === "distance") return metresAlong;
    const seconds = this.edgeSeconds(e, metresAlong);
    if (weight === "time") return seconds;
    // Fuel in millilitres: distance at the vehicle's L/100 km, plus idling at about 1 L per hour.
    return (metresAlong * litresPer100Km) / 100 + seconds / 3.6;
  }

  /**
   * Least-cost paths from one snapped point to every node. Returns per-node
   * cost, distance and time, and the half-edge used to arrive.
   */
  search(from: Snap, weight: Weight, litresPer100Km = 15) {
    const N = this.nodeCount;
    const cost = new Float64Array(N).fill(Infinity);
    const dist = new Float64Array(N);
    const time = new Float64Array(N);
    const viaEdge = new Int32Array(N).fill(-1);
    const viaDir = new Int8Array(N);
    const heap = new MinHeap();
    const e = from.edge;
    const len = this.eLen[e];
    const seed = (node: number, metresAlong: number, dir: number) => {
      const c = this.cost(e, metresAlong, weight, litresPer100Km);
      if (c < cost[node]) {
        cost[node] = c; dist[node] = metresAlong; time[node] = this.edgeSeconds(e, metresAlong);
        viaEdge[node] = -2 - e; viaDir[node] = dir; // -2 - e marks the starting edge
        heap.push(node, c);
      }
    };
    if (this.eFlags[e] & 1) seed(this.eTo[e], len - from.along, 1);
    if (this.eFlags[e] & 2) seed(this.eFrom[e], from.along, -1);
    while (heap.size) {
      const [u, c] = heap.pop();
      if (c > cost[u]) continue;
      for (let k = this.outStart[u]; k < this.outStart[u + 1]; k++) {
        const edge = this.outEdge[k];
        const dir = this.outDir[k];
        const v = dir === 1 ? this.eTo[edge] : this.eFrom[edge];
        const nc = c + this.cost(edge, this.eLen[edge], weight, litresPer100Km);
        if (nc < cost[v]) {
          cost[v] = nc; dist[v] = dist[u] + this.eLen[edge]; time[v] = time[u] + this.edgeSeconds(edge);
          viaEdge[v] = edge; viaDir[v] = dir;
          heap.push(v, nc);
        }
      }
    }
    return { from, weight, litresPer100Km, cost, dist, time, viaEdge, viaDir };
  }

  /** Best way to finish at a snapped point, given a finished search. */
  finish(s: ReturnType<RoadGraph["search"]>, to: Snap): Path | null {
    const e = to.edge;
    const len = this.eLen[e];
    let best: Path | null = null;
    const consider = (node: number, metresAlong: number, dir: 1 | -1) => {
      if (!Number.isFinite(s.cost[node])) return;
      const c = s.cost[node] + this.cost(e, metresAlong, s.weight, s.litresPer100Km);
      if (best && c >= best.cost) return;
      const parts = this.unwind(s, node);
      if (!parts) return;
      parts.push({ edge: e, fromM: dir === 1 ? 0 : len, toM: dir === 1 ? to.along : to.along });
      best = { parts, cost: c, distanceM: s.dist[node] + metresAlong, durationS: s.time[node] + this.edgeSeconds(e, metresAlong) };
    };
    if (this.eFlags[e] & 1) consider(this.eFrom[e], to.along, 1);
    if (this.eFlags[e] & 2) consider(this.eTo[e], len - to.along, -1);
    // Both points on the same edge, in an allowed direction: drive straight there.
    const f = s.from;
    if (f.edge === e) {
      const forward = to.along >= f.along;
      if ((forward && this.eFlags[e] & 1) || (!forward && this.eFlags[e] & 2)) {
        const m = Math.abs(to.along - f.along);
        const c = this.cost(e, m, s.weight, s.litresPer100Km);
        if (!best || c < (best as Path).cost) best = { parts: [{ edge: e, fromM: f.along, toM: to.along }], cost: c, distanceM: m, durationS: this.edgeSeconds(e, m) };
      }
    }
    return best;
  }

  private unwind(s: ReturnType<RoadGraph["search"]>, node: number): PathPart[] | null {
    const parts: PathPart[] = [];
    let v = node;
    for (let guard = 0; guard < this.nodeCount; guard++) {
      const edge = s.viaEdge[v];
      const dir = s.viaDir[v];
      if (edge <= -2) {
        const e = -2 - edge;
        parts.push({ edge: e, fromM: s.from.along, toM: dir === 1 ? this.eLen[e] : 0 });
        return parts.reverse();
      }
      if (edge === -1) return null;
      parts.push({ edge, fromM: dir === 1 ? 0 : this.eLen[edge], toM: dir === 1 ? this.eLen[edge] : 0 });
      v = dir === 1 ? this.eFrom[edge] : this.eTo[edge];
    }
    return null;
  }

  /** The road line for a path, in -180..180 longitudes. */
  line(path: Path): LngLat[] {
    const out: LngLat[] = [];
    for (const part of path.parts) {
      for (const p of this.slice(part)) {
        const q: LngLat = [wrap(p[0]), p[1]];
        const last = out[out.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
      }
    }
    return out;
  }

  /** Points of an edge between two distances along it, in travel order (unwrapped). */
  slice(part: PathPart): LngLat[] {
    const pts = this.edgePoints(part.edge);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
    const scale = cum[cum.length - 1] > 0 ? this.eLen[part.edge] / cum[cum.length - 1] : 1;
    const at = (m: number): LngLat => {
      const target = m / scale;
      for (let i = 1; i < pts.length; i++) {
        if (cum[i] >= target) {
          const t = cum[i] === cum[i - 1] ? 0 : (target - cum[i - 1]) / (cum[i] - cum[i - 1]);
          return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
        }
      }
      return pts[pts.length - 1];
    };
    const lo = Math.min(part.fromM, part.toM), hi = Math.max(part.fromM, part.toM);
    const out: LngLat[] = [at(lo)];
    for (let i = 1; i < pts.length - 1; i++) if (cum[i] * scale > lo && cum[i] * scale < hi) out.push(pts[i]);
    out.push(at(hi));
    return part.fromM <= part.toM ? out : out.reverse();
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    let i = this.ids.length;
    this.ids.push(id); this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.ids[0], this.keys[0]];
    const id = this.ids.pop()!, key = this.keys.pop()!;
    if (this.ids.length) {
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = key;
        if (l < n && this.keys[l] < mk) { m = l; mk = this.keys[l]; }
        if (r < n && this.keys[r] < mk) { m = r; mk = this.keys[r]; }
        if (m === i) break;
        this.ids[i] = this.ids[m]; this.keys[i] = this.keys[m];
        i = m;
      }
      this.ids[i] = id; this.keys[i] = key;
    }
    return top;
  }
}

let cached: RoadGraph | null | undefined;

/** The Fiji road graph, loaded once per server instance. Null when the data file is missing. */
export function loadRoadGraph(file = path.join(process.cwd(), "data", "fiji-roads.bin")): RoadGraph | null {
  if (cached !== undefined) return cached;
  try {
    cached = new RoadGraph(readFileSync(file));
  } catch {
    cached = null;
  }
  return cached;
}
