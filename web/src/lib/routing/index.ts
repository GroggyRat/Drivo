import "server-only";
import { serverEnv } from "@/lib/server-env";
import { EstimateRoutingProvider } from "./estimate";
import { RoadGraphRoutingProvider } from "./roadGraph";
import { RoutingServerProvider } from "./server";
import type { RoutingProvider } from "./types";

/**
 * A separate routing server when one is configured; otherwise Drivo's own
 * road graph (runs on Vercel); straight-line estimates only if the graph
 * file is missing.
 */
export function getRoutingProvider(): RoutingProvider {
  if (serverEnv.routingApiUrl && serverEnv.routingApiKey) {
    return new RoutingServerProvider(serverEnv.routingApiUrl, serverEnv.routingApiKey);
  }
  return RoadGraphRoutingProvider.load() ?? new EstimateRoutingProvider();
}
