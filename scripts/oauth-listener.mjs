import { createServer } from "node:http";

export async function startOAuthListener(
  origin,
  port = 1455,
  allowRemote = false,
) {
  const target = new URL(origin);
  if (
    (allowRemote ? target.protocol !== "https:" : target.protocol !== "http:") ||
    target.username ||
    target.password ||
    (!allowRemote && !["localhost", "127.0.0.1"].includes(target.hostname))
  )
    throw Error("OAuth callback target must be an HTTP(S) origin.");
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (
      request.method !== "GET" ||
      ![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host)
    ) {
      response.writeHead(400).end("Invalid callback request");
      return;
    }
    const url = new URL(request.url, `http://localhost:${port}`);
    if (
      url.pathname !== "/auth/callback" ||
      url.searchParams.getAll("state").length !== 1 ||
      !url.searchParams.get("state") ||
      (!url.searchParams.has("error") &&
        (url.searchParams.getAll("code").length !== 1 ||
          !url.searchParams.get("code"))) ||
      request.url.length > 10000
    ) {
      response.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    target.pathname = "/api/oauth/codex/callback";
    target.search = url.search;
    target.hash = "";
    response.writeHead(303, { Location: target.href }).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
