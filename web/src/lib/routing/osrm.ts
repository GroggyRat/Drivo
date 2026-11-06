import type { LngLat } from "@/lib/geo";
import { wrap, type Path, type RoadGraph } from "./graph";

// Turn-by-turn for the driver app from Drivo's road graph, in the OSRM route
// format that Ferrostar reads (with polyline6 geometry, banner and voice
// instructions). Instructions are in British English and distances in metres
// and kilometres. Fiji drives on the left; turn wording does not change.

type Segment = { name: string; points: LngLat[]; distanceM: number; durationS: number; junction: boolean };

type Step = {
  distance: number;
  duration: number;
  weight: number;
  geometry: string;
  name: string;
  mode: "driving";
  driving_side: "left";
  maneuver: { location: LngLat; bearing_before: number; bearing_after: number; type: string; modifier?: string; instruction: string };
  intersections: { location: LngLat; bearings: number[]; entry: boolean[]; in?: number; out?: number }[];
  bannerInstructions: { distanceAlongGeometry: number; primary: { text: string; type: string; modifier?: string; components: { type: string; text: string }[] } }[];
  voiceInstructions: { distanceAlongGeometry: number; announcement: string }[];
};

const RAD = Math.PI / 180;

function bearing(a: LngLat, b: LngLat) {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return Math.round(((Math.atan2(y, x) / RAD) + 360) % 360);
}

/** Polyline with 6 decimal places, as Valhalla and Ferrostar use. */
export function encodePolyline6(points: LngLat[]): string {
  let out = "", lastLat = 0, lastLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>>= 5; }
    out += String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of points) {
    const la = Math.round(lat * 1e6), lo = Math.round(wrap(lon) * 1e6);
    enc(la - lastLat); enc(lo - lastLon);
    lastLat = la; lastLon = lo;
  }
  return out;
}

function modifierFor(turn: number): string {
  const a = Math.abs(turn);
  if (a < 20) return "straight";
  if (a > 165) return "uturn";
  const side = turn > 0 ? "right" : "left";
  if (a < 55) return `slight ${side}`;
  if (a < 135) return side;
  return `sharp ${side}`;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

function roundDistance(m: number) {
  if (m >= 950) return `${(Math.round(m / 100) / 10).toString()} kilometres`;
  if (m >= 100) return `${Math.round(m / 50) * 50} metres`;
  return `${Math.max(10, Math.round(m / 10) * 10)} metres`;
}

function describe(type: string, modifier: string | undefined, name: string, firstBearing = 0): string {
  const onto = name ? ` onto ${name}` : "";
  switch (type) {
    case "depart": return `Head ${COMPASS[Math.round(firstBearing / 45) % 8]}${name ? ` on ${name}` : ""}`;
    case "arrive": return "You have arrived";
    case "new name":
    case "continue": return `Continue${onto}`;
    default:
      if (modifier === "uturn") return `Make a U-turn${onto}`;
      if (modifier?.startsWith("slight")) return `Keep ${modifier.replace("slight ", "")}${onto}`;
      if (modifier?.startsWith("sharp")) return `Turn sharp ${modifier.replace("sharp ", "")}${onto}`;
      if (modifier === "straight") return `Continue${onto}`;
      return `Turn ${modifier}${onto}`;
  }
}

function segments(graph: RoadGraph, path: Path): Segment[] {
  // junction: whether this segment starts where three or more roads meet.
  return path.parts.map((part, i) => {
    const distanceM = Math.abs(part.toM - part.fromM);
    const junction = i > 0 && graph.roadsAtEnd(path.parts[i - 1]) > 2;
    return { name: graph.edgeName(part.edge), points: graph.slice(part), distanceM, durationS: graph.edgeSeconds(part.edge, distanceM), junction };
  }).filter((s) => s.distanceM > 0.5 || s.points.length > 1);
}

/** Steps for one leg: depart, the turns, and arrive. */
function legSteps(graph: RoadGraph, path: Path): Step[] {
  const segs = segments(graph, path);
  // Group segments into steps: a new step where the road name changes or the road turns sharply.
  type Group = { name: string; points: LngLat[]; distanceM: number; durationS: number; turn: number; before: number; after: number };
  const groups: Group[] = [];
  for (const s of segs) {
    if (s.points.length < 2) continue;
    const g = groups[groups.length - 1];
    const after = bearing(s.points[0], s.points[1]);
    if (g) {
      const pts = g.points;
      const before = bearing(pts[pts.length - 2], pts[pts.length - 1]);
      const turn = ((after - before + 540) % 360) - 180;
      // Same road, or a bend with no other road to take: no instruction.
      if ((s.name === g.name && (Math.abs(turn) < 40 || !s.junction)) || (!s.junction && Math.abs(turn) < 40)) {
        g.points.push(...s.points.slice(1)); g.distanceM += s.distanceM; g.durationS += s.durationS;
        continue;
      }
      groups.push({ name: s.name, points: [...s.points], distanceM: s.distanceM, durationS: s.durationS, turn, before, after });
    } else {
      groups.push({ name: s.name, points: [...s.points], distanceM: s.distanceM, durationS: s.durationS, turn: 0, before: 0, after });
    }
  }
  // Short unnamed connectors (roundabouts, slip roads) become part of the
  // manoeuvre: fold them into the next step, turning by the net change of direction.
  for (let i = groups.length - 2; i > 0; i--) {
    const g = groups[i], next = groups[i + 1];
    if (!g.name && g.distanceM < 150) {
      next.points = [...g.points, ...next.points.slice(1)];
      next.distanceM += g.distanceM; next.durationS += g.durationS;
      next.before = g.before;
      next.turn = ((next.after - g.before + 540) % 360) - 180;
      next.after = g.after;
      groups.splice(i, 1);
    }
  }
  // Then join neighbours on the same road that no longer have a turn between them.
  for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i], prev = groups[i - 1];
    if (g.name && g.name === prev.name && Math.abs(g.turn) < 40) {
      prev.points.push(...g.points.slice(1)); prev.distanceM += g.distanceM; prev.durationS += g.durationS;
      groups.splice(i, 1);
    }
  }
  // Fold very short pieces (under 25 m, junction slivers) into the step before.
  for (let i = groups.length - 2; i > 0; i--) {
    if (groups[i].distanceM < 25) {
      const prev = groups[i - 1];
      prev.points.push(...groups[i].points.slice(1)); prev.distanceM += groups[i].distanceM; prev.durationS += groups[i].durationS;
      groups.splice(i, 1);
    }
  }

  const steps: Step[] = groups.map((g, i) => {
    const type = i === 0 ? "depart" : g.name !== groups[i - 1].name && Math.abs(g.turn) < 20 ? "new name" : "turn";
    const modifier = i === 0 ? undefined : modifierFor(g.turn);
    const instruction = describe(type, modifier, g.name, g.after);
    return {
      distance: Math.round(g.distanceM * 10) / 10,
      duration: Math.round(g.durationS * 10) / 10,
      weight: Math.round(g.durationS * 10) / 10,
      geometry: encodePolyline6(g.points),
      name: g.name,
      mode: "driving",
      driving_side: "left",
      maneuver: { location: [wrap(g.points[0][0]), g.points[0][1]], bearing_before: i === 0 ? 0 : g.before, bearing_after: g.after, type, ...(modifier ? { modifier } : {}), instruction },
      intersections: [{ location: [wrap(g.points[0][0]), g.points[0][1]], bearings: [g.after], entry: [true], out: 0 }],
      bannerInstructions: [],
      voiceInstructions: [],
    };
  });
  const last = groups[groups.length - 1];
  const end = last ? last.points[last.points.length - 1] : (graph.slice(path.parts[path.parts.length - 1]).pop() as LngLat);
  const endBearing = last ? bearing(last.points[last.points.length - 2], end) : 0;
  steps.push({
    distance: 0, duration: 0, weight: 0, geometry: encodePolyline6([end, end]), name: last?.name ?? "", mode: "driving", driving_side: "left",
    maneuver: { location: [wrap(end[0]), end[1]], bearing_before: endBearing, bearing_after: 0, type: "arrive", instruction: "You have arrived" },
    intersections: [{ location: [wrap(end[0]), end[1]], bearings: [endBearing], entry: [true], in: 0 }],
    bannerInstructions: [], voiceInstructions: [],
  });

  // Each step's banner and voice describe the manoeuvre at its end (the next step).
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i], next = steps[i + 1];
    const text = next.maneuver.type === "arrive" ? "You have arrived" : next.name || next.maneuver.instruction;
    s.bannerInstructions.push({
      distanceAlongGeometry: s.distance,
      primary: { text, type: next.maneuver.type, ...(next.maneuver.modifier ? { modifier: next.maneuver.modifier } : {}), components: [{ type: "text", text }] },
    });
    const action = next.maneuver.type === "arrive" ? "you will arrive" : next.maneuver.instruction.charAt(0).toLowerCase() + next.maneuver.instruction.slice(1);
    const nowAction = next.maneuver.type === "arrive" ? "You have arrived" : next.maneuver.instruction;
    if (i === 0) s.voiceInstructions.push({ distanceAlongGeometry: s.distance, announcement: `${s.maneuver.instruction}. Then, in ${roundDistance(s.distance)}, ${action}.` });
    if (s.distance > 1200) s.voiceInstructions.push({ distanceAlongGeometry: 1000, announcement: `In 1 kilometre, ${action}.` });
    if (s.distance > 450 && i > 0) s.voiceInstructions.push({ distanceAlongGeometry: 300, announcement: `In 300 metres, ${action}.` });
    if (s.distance > 90) s.voiceInstructions.push({ distanceAlongGeometry: 60, announcement: `${nowAction}.` });
    else if (i > 0) s.voiceInstructions.push({ distanceAlongGeometry: s.distance, announcement: `${nowAction}.` });
  }
  return steps;
}

/** An OSRM route response for paths between consecutive waypoints (one leg each). */
export function osrmResponse(graph: RoadGraph, paths: Path[], waypoints: LngLat[]) {
  const legs = paths.map((p) => {
    const steps = legSteps(graph, p);
    return {
      distance: Math.round(p.distanceM * 10) / 10,
      duration: Math.round(p.durationS * 10) / 10,
      weight: Math.round(p.durationS * 10) / 10,
      summary: [...new Set(steps.map((s) => s.name).filter(Boolean))].slice(0, 2).join(", "),
      steps,
      via_waypoints: [],
    };
  });
  const line: LngLat[] = [];
  for (const p of paths) for (const q of graph.line(p)) {
    const last = line[line.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) line.push(q);
  }
  const distance = legs.reduce((s, l) => s + l.distance, 0);
  const duration = legs.reduce((s, l) => s + l.duration, 0);
  return {
    code: "Ok",
    routes: [{ distance, duration, weight: duration, weight_name: "drivo", geometry: encodePolyline6(line), legs }],
    waypoints: waypoints.map((w) => ({ location: [wrap(w[0]), w[1]], name: "", distance: 0 })),
  };
}
