import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { Router, dispatchRequest } from "./router.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface NodeServerOptions {
  /** Directory of a built frontend to serve at `/` (SPA fallback). */
  staticDir?: string;
}

export function createNodeHttpServer(router: Router, options: NodeServerOptions = {}): Server {
  return createServer((req, res) => {
    void handle(router, req, res, options).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
      }
      res.end(JSON.stringify({ code: "internal_error", message: (error as Error).message }));
    });
  });
}

async function handle(router: Router, req: IncomingMessage, res: ServerResponse, options: NodeServerOptions): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  // Serve static frontend for non-API GET requests.
  if (options.staticDir && method === "GET" && !pathname.startsWith("/v1") && pathname !== "/health") {
    if (await serveStatic(res, options.staticDir, pathname)) return;
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
    method,
    headers,
    body,
    signal: controller.signal,
  });

  const response = await dispatchRequest(router, request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
  } else {
    res.end(await response.text());
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serveStatic(res: ServerResponse, dir: string, pathname: string): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(dir, relative));
  if (!candidate.startsWith(normalize(dir))) return false; // path traversal guard

  const tryServe = async (file: string): Promise<boolean> => {
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      const data = await readFile(file);
      res.statusCode = 200;
      res.setHeader("content-type", MIME_TYPES[extname(file)] ?? "application/octet-stream");
      res.end(data);
      return true;
    } catch {
      return false;
    }
  };

  if (existsSync(candidate) && (await tryServe(candidate))) return true;
  // SPA fallback for client-side routes
  if (!extname(pathname)) return tryServe(join(dir, "index.html"));
  return false;
}
