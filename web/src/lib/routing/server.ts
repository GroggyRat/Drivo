import "server-only";
import type { Objective, PlanRequest, RouteOption, RoutingProvider } from "./types";

// Calls our routing server (routing/api). Only the Drivo server talks to it,
// with a bearer key; browsers and phones never see the key.
export class RoutingServerProvider implements RoutingProvider {
  readonly source = "routing_server" as const;

  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Routing server answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }

  async plan(request: PlanRequest, objectives: Objective[] = ["lowest_fuel", "fastest", "shortest"]) {
    const result = await this.post<{ options: RouteOption[] }>("/v1/plan", { ...request, objectives });
    return result.options.map((o) => ({ ...o, source: this.source }));
  }

  async sequence(request: PlanRequest, objective: Objective) {
    const result = await this.post<{ option: RouteOption }>("/v1/sequence", { ...request, objective });
    return { ...result.option, source: this.source };
  }
}
