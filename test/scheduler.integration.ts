import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { claimOccurrence, manualExecution } from "../server/scheduler";
import type { Env, RequestContext, Schedule } from "../server/types";
import { nextOccurrence } from "../server/time";
import { readFile } from "node:fs/promises";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { handleRequest } from "../server/index";
import { decrypt, encrypt } from "../server/security";
import { account, credentials } from "../server/accounts";
import { SQLiteDatabase } from "../server/node-db";

const database = new SQLiteDatabase(":memory:");
let env: Env;
before(async () => {
  env = { database } as unknown as Env;
  const migration = await readFile(
    new URL("../migrations/0001_initial.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await env.database.prepare(statement).run();
  }
  await env.database
    .prepare(
      "INSERT INTO accounts (id,kind,provider,name,secret,config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(
      "acct",
      "oauth",
      "codex",
      "Codex",
      "encrypted",
      "{}",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
});
after(() => database.close());

test("atomic SQLite occurrence claim allows one concurrent claimant and no duplicate", async () => {
  const occurrence = new Date(Date.now() - 60000).toISOString();
  await env.database
    .prepare("INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(
      "sched",
      "Daily",
      "acct",
      "gpt-6-sol",
      "07:00",
      "Asia/Ho_Chi_Minh",
      "[0,1,2,3,4,5,6]",
      1,
      0,
      "ping",
      occurrence,
      occurrence,
      occurrence,
    )
    .run();
  const schedule = {
    id: "sched",
    name: "Daily",
    account_id: "acct",
    model: "gpt-6-sol",
    local_time: "07:00",
    timezone: "Asia/Ho_Chi_Minh",
    weekdays: "[0,1,2,3,4,5,6]",
    enabled: 1,
    skip_active: 0,
    preset: "ping",
    next_run: occurrence,
    created_at: occurrence,
    updated_at: occurrence,
  } satisfies Schedule;
  const at = new Date();
  const results = await Promise.all([
    claimOccurrence(env, schedule, at),
    claimOccurrence(env, schedule, at),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const count = await env.database
    .prepare(
      "SELECT count(*) n FROM executions WHERE schedule_id=? AND occurrence_at=?",
    )
    .bind("sched", occurrence)
    .first<{ n: number }>();
  assert.equal(count?.n, 1);
  const again = await claimOccurrence(env, schedule, at);
  assert.equal(again, null);
  const updated = await env.database
    .prepare("SELECT next_run FROM schedules WHERE id=?")
    .bind("sched")
    .first<{ next_run: string }>();
  assert.equal(
    updated?.next_run,
    nextOccurrence("07:00", "Asia/Ho_Chi_Minh", [0, 1, 2, 3, 4, 5, 6], at),
  );
});

test("occurrence more than five minutes late is recorded missed without inference", async () => {
  const occurrence = new Date(Date.now() - 360000).toISOString();
  await env.database
    .prepare("INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(
      "late",
      "Late",
      "acct",
      "gpt-6-sol",
      "07:00",
      "Asia/Ho_Chi_Minh",
      "[0,1,2,3,4,5,6]",
      1,
      0,
      "ping",
      occurrence,
      occurrence,
      occurrence,
    )
    .run();
  const schedule = {
    id: "late",
    name: "Late",
    account_id: "acct",
    model: "gpt-6-sol",
    local_time: "07:00",
    timezone: "Asia/Ho_Chi_Minh",
    weekdays: "[0,1,2,3,4,5,6]",
    enabled: 1,
    skip_active: 0,
    preset: "ping",
    next_run: occurrence,
    created_at: occurrence,
    updated_at: occurrence,
  } satisfies Schedule;
  const execution = await claimOccurrence(env, schedule, new Date());
  assert.equal(execution?.status, "missed");
  const rows = await env.database
    .prepare("SELECT status FROM executions WHERE schedule_id=?")
    .bind("late")
    .all<{ status: string }>();
  assert.deepEqual(
    rows.results.map((r) => r.status),
    ["missed"],
  );
});

test("authenticated API keeps provider secrets private and enforces origin, CSRF and OAuth allowlist", async () => {
  const salt = randomBytes(16),
    password = "test-password-for-api";
  const hash = `310000:${salt.toString("base64")}:${pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("base64")}`;
  const app = {
    ...env,
    assets: { fetch: async (request: Request) => new Response(new URL(request.url).pathname) },
    APP_ORIGIN: "http://localhost:8787",
    ADMIN_PASSWORD_HASH: hash,
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    SESSION_SECRET: Buffer.alloc(32, 8).toString("base64"),
    CUSTOM_PROVIDER_HOSTS: "api.openai.com",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
  } as unknown as Env;
  const context = { waitUntil() {} } satisfies RequestContext;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    csrf = "",
    origin = "http://localhost:8787",
  ) =>
    handleRequest(
      new Request(`http://localhost:8787/api${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      app,
      context,
    );
  const health = await handleRequest(
    new Request("http://localhost:8787/healthz"),
    app,
    context,
  );
  assert.equal(health.status, 200);
  assert.equal((await request("/accounts")).status, 401);
  const popup = await request("/oauth/codex/callback?code=synthetic-code");
  assert.equal(popup.status, 200);
  assert.match(popup.headers.get("Content-Type")!, /^text\/html/);
  assert.equal(popup.headers.get("Cache-Control"), "no-store");
  const popupHtml = await popup.text();
  assert.match(popupHtml, /Đang hoàn tất đăng nhập/);
  assert.doesNotMatch(popupHtml, /synthetic-code/);
  const popupScript = await request("/oauth/codex/callback.js");
  assert.equal(await popupScript.text(), "/oauth-callback.js");
  assert.equal(popupScript.headers.get("Cache-Control"), "no-store");
  assert.equal((await request("/oauth/codex/complete", "POST", {})).status, 401);
  const login = await request("/login", "POST", { password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  const { csrf } = (await login.json()) as { csrf: string };
  assert.match(login.headers.get("Set-Cookie")!, /HttpOnly; SameSite=Lax/);
  assert.equal(
    (
      await request(
        "/accounts",
        "POST",
        {
          provider: "openai-compatible",
          name: "Example",
          baseUrl: "http://api.openai.com",
          apiKey: "never-return-this",
          models: ["gpt-test"],
        },
        cookie,
        csrf,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/accounts",
        "POST",
        {
          provider: "openai-compatible",
          name: "Example",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "never-return-this",
          models: ["gpt-test"],
        },
        cookie,
        csrf,
        "https://evil.example",
      )
    ).status,
    403,
  );
  const created = await request(
    "/accounts",
    "POST",
    {
      provider: "openai-compatible",
      name: "Example",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "never-return-this",
      models: ["gpt-test"],
    },
    cookie,
    csrf,
  );
  assert.equal(created.status, 201);
  const list = await request("/accounts", "GET", undefined, cookie);
  const publicAccounts = (await list.json()) as any[];
  assert.equal(publicAccounts[0].credentialMask, "••••••••");
  assert.equal(
    JSON.stringify(publicAccounts).includes("never-return-this"),
    false,
  );
  const stamp = new Date().toISOString();
  await app.database
    .prepare(
      "INSERT INTO accounts (id,kind,provider,name,secret,config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(
      "codex-scheduler",
      "oauth",
      "codex",
      "Codex subscription",
      await encrypt(
        {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: "2099-01-01T00:00:00Z",
          accountId: "acct",
        },
        app,
        "account:codex-scheduler",
      ),
      "{}",
      stamp,
      stamp,
    )
    .run();
  const savedSchedule = await request(
    "/schedules",
    "POST",
    {
      name: "Daily 07:00",
      accountId: "codex-scheduler",
      model: "gpt-6-sol",
      localTime: "07:00",
      timezone: "Asia/Ho_Chi_Minh",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    cookie,
    csrf,
  );
  assert.equal(savedSchedule.status, 201);
  assert.equal(
    (
      (await (
        await request("/schedules", "GET", undefined, cookie)
      ).json()) as any[]
    ).filter((schedule) => schedule.name === "Daily 07:00").length,
    1,
  );
  assert.equal(
    (await request("/oauth/extra/start", "POST", {}, cookie, csrf)).status,
    404,
  );
  const start = await request("/oauth/codex/start", "POST", {}, cookie, csrf);
  assert.equal(start.status, 200);
  const flow = (await start.json()) as {
    authUrl: string;
    state: string;
    redirectUri: string;
  };
  assert.equal(new URL(flow.authUrl).searchParams.get("state"), flow.state);
  assert.equal(flow.redirectUri, "http://localhost:1455/auth/callback");
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = `${encode({ alg: "none" })}.${encode({
    sub: "provider-user-1",
    email: "codex@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: "upstream-account-1" },
  })}.signature`;
  const originalFetch = globalThis.fetch;
  const tokenBodies: (URLSearchParams | Record<string, unknown>)[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    const contentType = new Headers(init?.headers).get("Content-Type");
    tokenBodies.push(
      contentType === "application/json"
        ? JSON.parse(String(init?.body))
        : new URLSearchParams(String(init?.body)),
    );
    return Response.json({
      access_token: "oauth-access",
      refresh_token: "oauth-refresh",
      id_token: idToken,
      expires_in: 3600,
    });
  };
  try {
    const complete = await request(
      "/oauth/codex/complete",
      "POST",
      { state: flow.state, code: `authorization-code#${flow.state}` },
      cookie,
      csrf,
    );
    assert.equal(complete.status, 200);
    assert.equal(
      (tokenBodies[0] as URLSearchParams).get("code"),
      `authorization-code#${flow.state}`,
    );
    assert.equal((tokenBodies[0] as URLSearchParams).has("state"), false);
    const createdOAuth = (await complete.json()) as { accountId: string };
    const reconnect = await request(
      "/oauth/codex/start",
      "POST",
      { accountId: createdOAuth.accountId },
      cookie,
      csrf,
    );
    const reconnectFlow = (await reconnect.json()) as { state: string };
    const reconnected = await request(
      "/oauth/codex/complete",
      "POST",
      {
        state: reconnectFlow.state,
        code: `another-code#${reconnectFlow.state}`,
      },
      cookie,
      csrf,
    );
    assert.equal(reconnected.status, 200);
    assert.equal(
      ((await reconnected.json()) as { accountId: string }).accountId,
      createdOAuth.accountId,
    );
    const refreshed = await credentials(
      app,
      await account(app, createdOAuth.accountId),
      true,
    );
    assert.equal(refreshed.accessToken, "oauth-access");
    assert.equal(
      (tokenBodies[2] as Record<string, unknown>).refresh_token,
      "oauth-refresh",
    );
    const stored = await app.database
      .prepare("SELECT secret FROM accounts WHERE id=?")
      .bind(createdOAuth.accountId)
      .first<{ secret: string }>();
    assert.ok(stored);
    assert.deepEqual(
      await decrypt(stored.secret, app, `account:${createdOAuth.accountId}`),
      refreshed,
    );
    const oauthCount = await app.database
      .prepare(
        "SELECT count(*) AS count FROM accounts WHERE provider='codex' AND identity IS NOT NULL",
      )
      .first<{ count: number }>();
    assert.equal(oauthCount?.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const scheduleRow = await app.database
    .prepare("SELECT * FROM schedules WHERE name='Daily 07:00'")
    .first<Schedule>();
  assert.ok(scheduleRow);
  const submissions = await Promise.all([
    manualExecution(app, scheduleRow!, crypto.randomUUID()),
    manualExecution(app, scheduleRow!, crypto.randomUUID()).then(
      () => null,
      () => null,
    ),
  ]);
  assert.equal(submissions.filter(Boolean).length, 1);
  assert.equal(submissions.filter((result) => result?.claimed).length, 1);
});
