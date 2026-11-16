import assert from "node:assert/strict";
import test from "node:test";
import {
  encrypt,
  decrypt,
  validateEndpoint,
  validateHeaders,
} from "../server/security";
import {
  normalizeQuota,
  authURL,
  PROVIDERS,
  invoke,
  testCustom,
} from "../server/providers";
import { nextOccurrence } from "../server/time";
import type { Env } from "../server/types";

const env = {
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  CUSTOM_PROVIDER_HOSTS: "api.openai.com",
} as Env;

test("credentials are AES-GCM encrypted with account isolation", async () => {
  const encrypted = await encrypt({ apiKey: "secret-value" }, env, "account:1");
  assert.ok(!encrypted.includes("secret-value"));
  assert.deepEqual(await decrypt(encrypted, env, "account:1"), {
    apiKey: "secret-value",
  });
  await assert.rejects(decrypt(encrypted, env, "account:2"));
});

test("custom provider URLs allow only approved HTTPS hosts", () => {
  assert.equal(
    validateEndpoint("https://api.openai.com/v1", env),
    "https://api.openai.com/v1",
  );
  for (const url of [
    "http://api.openai.com/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://api.openai.com.evil.test/v1",
    "https://api.openai.com@127.0.0.1/v1",
    "https://api.openai.com/v1?x=1",
  ])
    assert.throws(() => validateEndpoint(url, env));
  assert.throws(() => validateHeaders({ Authorization: "override" }));
});

test("custom provider connectivity check only requests models", async () => {
  const calls: { url: string; method: string; apiKey: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/"))
      return Response.json({
        Status: 0,
        Answer: url.includes("type=A")
          ? [{ type: 1, data: "104.18.32.47" }]
          : [],
      });
    calls.push({
      url,
      method: init?.method || "GET",
      apiKey: new Headers(init?.headers).get("x-api-key"),
    });
    return Response.json({ data: [{ id: "anthropic-test" }] });
  };
  const result = await testCustom(
    { baseUrl: "https://api.openai.com/v1" },
    { apiKey: "private-key" },
    "anthropic-compatible",
    env,
    fetcher,
  );
  assert.deepEqual(calls, [
    {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      apiKey: "private-key",
    },
  ]);
  assert.deepEqual(result.models, ["anthropic-test"]);
});

test("quota parser preserves separate windows and rejects guessed Codex windows", () => {
  const codex = normalizeQuota("codex", {
    rate_limit: {
      primary_window: {
        used_percent: 40,
        limit_window_seconds: 18000,
        reset_at: 1800000000,
      },
      secondary_window: {
        used_percent: 80,
        limit_window_seconds: 604800,
        reset_at: 1800100000,
      },
    },
  });
  assert.equal(codex.window5h?.remaining, 60);
  assert.equal(codex.weekly?.remaining, 20);
  assert.deepEqual(
    normalizeQuota("codex", {
      rate_limit: { primary_window: { used_percent: 50 } },
    }),
    { window5h: { remaining: 50, limit: 100, resetAt: null }, weekly: null },
  );
});

test("OAuth authorization URL uses state, PKCE challenge and real redirect URI", () => {
  const config = {
    APP_ORIGIN: "https://quota.example",
    CODEX_REDIRECT_URI: "http://localhost:1455/auth/callback",
    CODEX_CLIENT_ID: "",
  } as Env;
  const url = new URL(
    authURL("codex", config, "random-state", "pkce-challenge"),
  );
  assert.equal(url.searchParams.get("state"), "random-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), config.CODEX_REDIRECT_URI);
  assert.equal(
    new URL(PROVIDERS.codex.authorize).origin,
    "https://auth.openai.com",
  );
});

test("Codex inference requires a completed response event and sends one request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    assert.equal(init?.method, "POST");
    return new Response(
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  await invoke(
    "codex",
    { accessToken: "access", accountId: "account" },
    "gpt-6-sol",
    "ping",
    fetcher,
  );
  assert.equal(calls, 1);
  await invoke(
    "codex",
    { accessToken: "access" },
    "gpt-6-sol",
    "ping",
    async () =>
      new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "Content-Type": "text/plain;charset=UTF-8" } },
      ),
  );
  for (const [body, code] of [
    ["OK", "inference_unconfirmed"],
    ['data: {"type":"response.created"}\n\n', "inference_unconfirmed"],
    ['data: {"type":"response.failed"}\n\n', "inference_failed"],
  ])
    await assert.rejects(
      invoke(
        "codex",
        { accessToken: "access" },
        "gpt-6-sol",
        "ping",
        async () =>
          new Response(body, {
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
          }),
      ),
      { message: code },
    );
  await assert.rejects(
    invoke(
      "codex",
      { accessToken: "access" },
      "gpt-6-sol",
      "ping",
      async () =>
        new Response('data: {"type":"response.incomplete"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    ),
  );
  await invoke(
    "codex",
    { accessToken: "access" },
    "gpt-6-sol",
    "ping",
    async () =>
      new Response(
        'event: response.done\ndata: {"response":{"status":"completed"}}\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
});

test("timezone schedules use local wall time across offsets and DST boundaries", () => {
  assert.equal(
    nextOccurrence(
      "07:00",
      "Asia/Ho_Chi_Minh",
      [0, 1, 2, 3, 4, 5, 6],
      new Date("2026-11-11T23:00:00Z"),
    ),
    "2026-11-12T00:00:00.000Z",
  );
  assert.equal(
    nextOccurrence(
      "09:30",
      "America/New_York",
      [1, 2, 3, 4, 5],
      new Date("2026-03-06T15:00:00Z"),
    ),
    "2026-03-09T13:30:00.000Z",
  );
  // Spring-forward 02:30 does not exist; skip rather than silently moving the job.
  assert.equal(
    nextOccurrence(
      "02:30",
      "America/New_York",
      [0],
      new Date("2026-03-08T05:00:00Z"),
    ),
    "2026-03-15T06:30:00.000Z",
  );
  // Repeated 01:30 runs once, at the first wall-clock occurrence.
  assert.equal(
    nextOccurrence(
      "01:30",
      "America/New_York",
      [0],
      new Date("2026-11-01T04:00:00Z"),
    ),
    "2026-11-01T05:30:00.000Z",
  );
});
