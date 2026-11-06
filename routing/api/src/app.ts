import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PlanningError, RoutingEngine, UpstreamError } from "./engine.js";
import { mapMatchBody, planBody, sequenceBody } from "./schemas.js";

// The routing API. Every route except /health needs Authorization:
// Bearer <ROUTING_API_KEY>. Only the Drivo backend holds the key.
//
//   POST /v1/plan               three options (lowest fuel, fastest, shortest)
//   POST /v1/sequence           times and line for a fixed stop order
//   POST /v1/navigation/route   turn-by-turn for Ferrostar (Valhalla, OSRM format)
//   POST /v1/map-match          snap a GPS trace to roads
//   GET  /health

const MAX_BODY = 5_000_000;

export function createHandler({ apiKey, engine, valhallaUrl, costing, fetchImpl = fetch }: {
  apiKey: string;
  engine: RoutingEngine;
  valhallaUrl: string;
  costing: string;
  fetchImpl?: typeof fetch;
}) {
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        } catch {
          reject(new Error("not json"));
        }
      });
      req.on("error", reject);
    });

  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      try {
        const r = await fetchImpl(`${valhallaUrl}/status`, { signal: AbortSignal.timeout(3000) });
        return send(res, r.ok ? 200 : 503, { ok: r.ok });
      } catch {
        return send(res, 503, { ok: false });
      }
    }
    const given = Buffer.from(req.headers.authorization ?? "");
    if (!apiKey || given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 401, { error: "Not allowed" });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, (e as Error).message === "too large" ? 413 : 400, { error: (e as Error).message });
    }

    try {
      if (path === "/v1/plan") {
        const p = planBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "Invalid plan request", issues: p.error.issues.slice(0, 5) });
        return send(res, 200, { options: await engine.plan(p.data, p.data.objectives) });
      }
      if (path === "/v1/sequence") {
        const p = sequenceBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "Invalid sequence request", issues: p.error.issues.slice(0, 5) });
        return send(res, 200, { option: await engine.route(p.data, p.data.stops.map((s) => s.id), p.data.objective) });
      }
      if (path === "/v1/map-match") {
        const p = mapMatchBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "Invalid trace" });
        return send(res, 200, await engine.mapMatch(p.data.points));
      }
      if (path === "/v1/navigation/route") {
        // Ferrostar's Valhalla adapter request, passed through with the
        // options Ferrostar needs. Costing is fixed by this server.
        const b = (body ?? {}) as Record<string, unknown>;
        const upstream = await fetchImpl(`${valhallaUrl}/route`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...b, costing: costing, format: "osrm", banner_instructions: true, voice_instructions: true, units: "kilometers" }),
          signal: AbortSignal.timeout(30_000),
        });
        res.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(Buffer.from(await upstream.arrayBuffer()));
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      if (e instanceof PlanningError) return send(res, 422, { error: e.message });
      if (e instanceof UpstreamError) return send(res, 502, { error: e.message });
      return send(res, 500, { error: "Routing failed" });
    }
  };
}
