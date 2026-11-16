import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const maxImportBytes = 25 * 1024 * 1024;

const allowedHosts = new Set([
  "chatgpt.com",
  "auth.openai.com",
  "api.anthropic.com",
]);

export async function startUpstreamBridge(port = 8789) {
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        !["/fetch", "/import-9router"].includes(request.url)
      ) {
        response.writeHead(404).end();
        return;
      }
      if (request.url === "/import-9router") {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > maxImportBytes) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const directory = await mkdtemp(join(tmpdir(), "quota-pilot-import-"));
        try {
          const database = join(directory, "9router.sqlite");
          const bytes = Buffer.concat(chunks);
          if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0")
            throw new Error("invalid_database");
          await writeFile(database, bytes, { mode: 0o600 });
          const { stdout } = await run(
            "sqlite3",
            [
              "-json",
              "-readonly",
              database,
              "select provider,name,email,data from providerConnections where provider in ('claude','codex') and authType='oauth' limit 501",
            ],
            { maxBuffer: 32 * 1024 * 1024 },
          );
          const accounts = JSON.parse(stdout || "[]").map((row) => ({
            provider: row.provider,
            name: row.name || row.email || `${row.provider} account`,
            data: JSON.parse(row.data),
          }));
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ accounts }));
        } catch (error) {
          response.writeHead(error.code === "ENOENT" ? 501 : 400).end();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const target = new URL(String(payload.url));
      if (target.protocol !== "https:" || !allowedHosts.has(target.hostname)) {
        response.writeHead(403).end("upstream host blocked");
        return;
      }
      const upstream = await fetch(target, {
        method: payload.method === "POST" ? "POST" : "GET",
        headers: payload.headers || {},
        body: payload.method === "POST" ? payload.body || null : undefined,
      });
      const body = await upstream.text();
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          status: upstream.status,
          headers: Object.fromEntries(upstream.headers.entries()),
          body,
        }),
      );
    } catch {
      response.writeHead(502).end("upstream fetch failed");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
