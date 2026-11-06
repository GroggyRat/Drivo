import "server-only";
import { serverEnv } from "@/lib/server-env";
import { EstimateRoutingProvider } from "./estimate";
import { RoutingServerProvider } from "./server";
import type { RoutingProvider } from "./types";

export function getRoutingProvider(): RoutingProvider {
  if (serverEnv.routingApiUrl && serverEnv.routingApiKey) {
    return new RoutingServerProvider(serverEnv.routingApiUrl, serverEnv.routingApiKey);
  }
  return new EstimateRoutingProvider();
}
