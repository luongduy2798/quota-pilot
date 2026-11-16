import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { handleRequest, runScheduled } from "./index";
import { SQLiteDatabase, applyMigrations } from "./node-db";
import type { Env, RequestContext } from "./types";

function loadFileEnv(path: string) {
  if (!existsSync(path)) return {} as Record<string, string>;
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.trimStart().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        const value = line.slice(index + 1).trim();
        return [
          line.slice(0, index).trim(),
          value.replace(/^(['"])(.*)\1$/, "$2"),
        ];
      })
      .filter(([key]) => key),
  );
}

function createAssets(root: string) {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  return {
    async fetch(request: Request) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", { status: 405 });
      const url = new URL(request.url);
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      if (pathname.includes("\0"))
        return new Response("Not found", { status: 404 });
      let path = resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      if (path !== root && !path.startsWith(`${root}/`))
        return new Response("Not found", { status: 404 });
      try {
        if (!(await stat(path)).isFile()) throw new Error("not_file");
      } catch {
        path = join(root, "index.html");
      }
      const body = await readFile(path);
      return new Response(request.method === "HEAD" ? null : body, {
        headers: {
          "Content-Type": types[extname(path)] || "application/octet-stream",
          "Cache-Control": path.endsWith("index.html")
            ? "no-store"
            : "public, max-age=31536000, immutable",
        },
      });
    },
  };
}

function headers(request: IncomingMessage) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers))
    if (typeof value === "string") result[key] = value;
  return result;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  env: Env,
  context: RequestContext,
) {
  const protocol = env.APP_ORIGIN.startsWith("https:") ? "https" : "http";
  const host = request.headers.host || "127.0.0.1";
  const body = ["GET", "HEAD"].includes(request.method || "GET")
    ? undefined
    : (Readable as any).toWeb(request);
  const webRequest = new Request(`${protocol}://${host}${request.url || "/"}`, {
    method: request.method,
    headers: headers(request),
    body,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
  const webResponse = await handleRequest(webRequest, env, context);
  response.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers),
  );
  if (!webResponse.body || request.method === "HEAD") {
    response.end();
    return;
  }
  (Readable as any).fromWeb(webResponse.body).pipe(response);
}

async function main() {
  const values = {
    ...loadFileEnv(".env"),
    ...process.env,
  };
  const port = Number(values.PORT || 8788);
  const dbPath = values.DB_PATH || "./data/quota-pilot.sqlite";
  await mkdir(dirname(resolve(dbPath)), { recursive: true });
  await mkdir("dist/client", { recursive: true });
  const database = new SQLiteDatabase(dbPath);
  await applyMigrations(database, resolve("migrations"));
  const origin = values.APP_ORIGIN || `http://127.0.0.1:${port}`;
  const env = {
    ...values,
    APP_ORIGIN: origin,
    CODEX_REDIRECT_URI:
      values.CODEX_REDIRECT_URI || "http://localhost:1455/auth/callback",
    database,
    assets: createAssets(resolve("dist/client")),
  } as unknown as Env;
  const context: RequestContext = {
    waitUntil(promise) {
      void promise.catch((error) =>
        console.error("background task failed", error),
      );
    },
  };
  const server = createServer((request, response) => {
    void handle(request, response, env, context).catch((error) => {
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "internal_error" }));
      console.error(error instanceof Error ? error.message : error);
    });
  });
  const cron = setInterval(() => runScheduled(env, context), 60000);
  server.listen(port, values.HOST || "0.0.0.0", () =>
    console.log(`Quota Pilot listening on ${origin}`),
  );
  const close = () => {
    clearInterval(cron);
    server.close(() => database.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
