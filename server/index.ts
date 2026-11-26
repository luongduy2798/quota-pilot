import {
  AppError,
  type Account,
  type Env,
  type Execution,
  type RequestContext,
  type Schedule,
  classify,
  now,
  rows,
  run,
} from "./types";
import {
  csrfCheck,
  jsonBody,
  login,
  originCheck,
  session,
  sessionCookie,
  textField,
} from "./security";
import {
  account,
  allQuotas,
  beginOAuth,
  credentials,
  deleteAccounts,
  finishOAuth,
  import9RouterAccounts,
  import9RouterDatabase,
  publicAccount,
  quota,
  saveCustom,
  testAccount,
} from "./accounts";
import { oauthProvider } from "./providers";
import {
  execute,
  manualExecution,
  publicSchedule,
  saveSchedule,
  saveSchedules,
  schedule,
  tick,
} from "./scheduler";
import { validateTimezone } from "./time";

const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
async function route(
  request: Request,
  env: Env,
  context: RequestContext,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === "/healthz") {
    await env.database.prepare("SELECT 1").first();
    return json({ ok: true });
  }
  if (!path.startsWith("/api/")) return env.assets.fetch(request);
  if (!env.ENCRYPTION_KEY || !env.SESSION_SECRET || !env.ADMIN_PASSWORD_HASH)
    throw new AppError("server_not_configured", 503);
  if (path === "/api/oauth/codex/callback.js" && method === "GET")
    return env.assets.fetch(new Request(new URL("/oauth-callback.js", url)));
  if (path === "/api/oauth/codex/callback" && method === "GET")
    return new Response(
      `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Đăng nhập Quota Pilot</title>
    <script src="/api/oauth/codex/callback.js" defer></script>
  </head>
  <body>
    <main>
      <h1>Đăng nhập Quota Pilot</h1>
      <p role="status">Đang hoàn tất đăng nhập…</p>
    </main>
  </body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  const mutation = !["GET", "HEAD"].includes(method);
  if (mutation) originCheck(request, env);
  if (path === "/api/login" && method === "POST") {
    const body = await jsonBody(request);
    const result = await login(
      request,
      env,
      textField(body.password, "password", 500),
    );
    return json({ csrf: result.csrf }, 200, {
      "Set-Cookie": sessionCookie(result.token, env),
    });
  }
  const current = await session(request, env);
  if (mutation) csrfCheck(request, current);
  if (path === "/api/session" && method === "GET")
    return json({
      csrf: current.csrf,
      timezone: env.DEFAULT_TIMEZONE || "Asia/Ho_Chi_Minh",
    });
  if (path === "/api/logout" && method === "POST") {
    await run(env, "DELETE FROM sessions WHERE id=?", current.id);
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie("", env, true),
    });
  }
  if (path === "/api/accounts" && method === "GET")
    return json(
      (
        await rows<Account>(env, "SELECT * FROM accounts ORDER BY created_at")
      ).map((a) => publicAccount(a, env)),
    );
  if (path === "/api/accounts" && method === "POST")
    return json({ id: await saveCustom(env, await jsonBody(request)) }, 201);
  if (path === "/api/accounts" && method === "DELETE")
    return json(await deleteAccounts(env, (await jsonBody(request)).ids));
  if (path === "/api/accounts/import-9router" && method === "POST")
    return json(
      await import9RouterAccounts(env, (await jsonBody(request)).accounts),
    );
  if (path === "/api/accounts/import-9router-file" && method === "POST") {
    if (request.headers.get("Content-Type") !== "application/vnd.sqlite3")
      throw new AppError("invalid_import_file", 415);
    const reader = request.body?.getReader();
    if (!reader) throw new AppError("invalid_import_file");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 25 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError("invalid_import_file", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const file = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      file.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const { accounts } = import9RouterDatabase(file);
    if (!Array.isArray(accounts) || accounts.length > 500)
      throw new AppError("invalid_import");
    const imported: string[] = [];
    let skipped = 0;
    for (let offset = 0; offset < accounts.length; offset += 50) {
      const batch = await import9RouterAccounts(
        env,
        accounts.slice(offset, offset + 50),
      );
      imported.push(...batch.imported);
      skipped += batch.skipped;
    }
    return json({ imported, skipped });
  }
  const oauth = path.match(/^\/api\/oauth\/(codex)\/(start|complete)$/);
  if (oauth) {
    const provider = oauthProvider(oauth[1]);
    if (oauth[2] === "start" && method === "POST")
      return json(
        await beginOAuth(env, provider, current, await jsonBody(request)),
      );
    if (oauth[2] === "complete" && method === "POST")
      return json(
        await finishOAuth(env, provider, current, await jsonBody(request)),
      );
  }
  const accountRoute = path.match(
    /^\/api\/accounts\/([a-zA-Z0-9-]+)(?:\/(test|refresh))?$/,
  );
  if (accountRoute) {
    const value = await account(env, accountRoute[1]);
    if (!accountRoute[2] && method === "PATCH") {
      await saveCustom(env, await jsonBody(request), value);
      return json({ ok: true });
    }
    if (!accountRoute[2] && method === "DELETE") {
      const result = await run(
        env,
        "DELETE FROM accounts WHERE id=? AND (work_lock_until IS NULL OR work_lock_until<?) AND (refresh_lock_until IS NULL OR refresh_lock_until<?)",
        value.id,
        now(),
        now(),
      );
      if (!result.meta.changes) throw new AppError("account_busy", 409);
      return json({ ok: true });
    }
    if (accountRoute[2] === "test" && method === "POST")
      return json(await testAccount(env, value));
    if (accountRoute[2] === "refresh" && method === "POST") {
      if (value.kind !== "oauth") throw new AppError("oauth_account_required");
      if (
        value.last_refresh &&
        Date.now() - Date.parse(value.last_refresh) < 60000
      )
        throw new AppError("refresh_rate_limited", 429);
      await credentials(env, value, true);
      return json({ ok: true });
    }
  }
  if (path === "/api/quotas" && method === "GET")
    return json(await allQuotas(env));
  const refreshQuota = path.match(/^\/api\/quotas\/([a-zA-Z0-9-]+)\/refresh$/);
  if (refreshQuota && method === "POST")
    return json(
      await quota(env, await account(env, refreshQuota[1]), "manual"),
    );
  if (path === "/api/schedules" && method === "GET") {
    const values = await rows<Schedule & { last_status: string | null }>(
      env,
      "SELECT s.*,(SELECT status FROM executions e WHERE e.schedule_id=s.id ORDER BY occurrence_at DESC LIMIT 1) AS last_status FROM schedules s ORDER BY created_at",
    );
    return json(values.map(publicSchedule));
  }
  if (path === "/api/schedules" && method === "POST") {
    const body = await jsonBody(request);
    return json(
      Array.isArray(body.accountIds)
        ? await saveSchedules(env, body)
        : { id: await saveSchedule(env, body) },
      201,
    );
  }
  const scheduleRoute = path.match(
    /^\/api\/schedules\/([a-zA-Z0-9-]+)(?:\/(run-now|executions))?$/,
  );
  if (scheduleRoute) {
    const value = await schedule(env, scheduleRoute[1]);
    if (!scheduleRoute[2] && method === "PATCH") {
      await saveSchedule(env, await jsonBody(request), value);
      return json({ ok: true });
    }
    if (!scheduleRoute[2] && method === "DELETE") {
      const result = await run(
        env,
        "DELETE FROM schedules WHERE id=? AND NOT EXISTS (SELECT 1 FROM executions WHERE schedule_id=? AND status='running')",
        value.id,
        value.id,
      );
      if (!result.meta.changes) throw new AppError("schedule_busy", 409);
      return json({ ok: true });
    }
    if (scheduleRoute[2] === "executions" && method === "GET")
      return json(
        await rows<Execution>(
          env,
          "SELECT * FROM executions WHERE schedule_id=? ORDER BY occurrence_at DESC LIMIT 100",
          value.id,
        ),
      );
    if (scheduleRoute[2] === "run-now" && method === "POST") {
      const body = await jsonBody(request);
      if (body.acknowledgeQuota !== true)
        throw new AppError("quota_acknowledgement_required");
      const target = publicAccount(await account(env, value.account_id), env);
      if (!target.schedulerSupported || !target.enabled)
        throw new AppError("account_scheduler_unavailable", 409);
      const result = await manualExecution(
        env,
        value,
        request.headers.get("Idempotency-Key") || "",
      );
      if (result.claimed)
        context.waitUntil(execute(env, result.execution, value));
      return json({ execution: result.execution }, result.claimed ? 202 : 200);
    }
  }
  if (path === "/api/executions" && method === "GET") {
    const accountId = url.searchParams.get("accountId");
    return json(
      accountId
        ? await rows<Execution>(
            env,
            "SELECT * FROM executions WHERE account_id=? ORDER BY occurrence_at DESC LIMIT 100",
            accountId,
          )
        : await rows<Execution>(
            env,
            "SELECT * FROM executions ORDER BY occurrence_at DESC LIMIT 100",
          ),
    );
  }
  if (path === "/api/settings/timezone" && method === "POST")
    return json({
      timezone: validateTimezone((await jsonBody(request)).timezone),
    });
  throw new AppError("not_found", 404);
}
export async function handleRequest(
  request: Request,
  env: Env,
  context: RequestContext,
) {
  let response: Response;
  try {
    response = await route(request, env, context);
  } catch (error) {
    response = json(
      {
        error: classify(error),
        ...(error instanceof AppError && error.retryAfterSeconds
          ? { retryAfter: error.retryAfterSeconds }
          : {}),
      },
      error instanceof AppError ? error.status : 500,
    );
  }
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (new URL(request.url).pathname.startsWith("/api/"))
    headers.set("Cache-Control", "no-store");
  if (env.APP_ORIGIN?.startsWith("https:"))
    headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(response.body, { status: response.status, headers });
}

export function runScheduled(env: Env, context: RequestContext) {
  context.waitUntil(tick(env));
}
