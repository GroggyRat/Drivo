import { createServer } from "node:http";
import { createHandler } from "./app.js";
import { RoutingEngine } from "./engine.js";

const apiKey = process.env.ROUTING_API_KEY ?? "";
if (apiKey.length < 24) throw new Error("ROUTING_API_KEY must be at least 24 characters");
const valhallaUrl = process.env.VALHALLA_URL ?? "http://valhalla:8002";
const costing = process.env.COSTING ?? "truck";
const engine = new RoutingEngine({ valhallaUrl, vroomUrl: process.env.VROOM_URL ?? "http://vroom:3000", costing });

createServer(createHandler({ apiKey, engine, valhallaUrl, costing })).listen(8080, () => console.log("Drivo routing API on :8080"));
