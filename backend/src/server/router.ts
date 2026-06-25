export type RouteHandler = (request: Request, ctx: { params: Record<string, string> }) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** A tiny segment-matching router (`:param` extraction, exact segment count). */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), segments: path.split("/").filter(Boolean), handler });
  }

  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | undefined {
    const segments = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pattern = route.segments[i];
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(segments[i]);
        } else if (pattern !== segments[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return undefined;
  }
}

export async function dispatchRequest(router: Router, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = router.match(request.method, url.pathname);
  if (!match) return new Response(JSON.stringify({ code: "not_found", message: "route not found" }), { status: 404, headers: { "content-type": "application/json" } });
  return match.handler(request, { params: match.params });
}
