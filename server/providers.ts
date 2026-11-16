// Adapted from local 9Router 0.5.116 (MIT). See docs/EXTRACTION_MAP.md.
import {
  AppError,
  type Env,
  type OAuthProvider,
  type QuotaData,
  type Secret,
  type WindowQuota,
} from "./types";
import { boundedText, checkPublicDNS, validateEndpoint } from "./security";

export async function upstreamFetch(
  env: Pick<Env, "UPSTREAM_PROXY_URL">,
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
) {
  if (!env.UPSTREAM_PROXY_URL) return fetcher(url, init);
  const proxy = await fetcher(env.UPSTREAM_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: init.method || "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : null,
    }),
  });
  if (!proxy.ok) throw new AppError("upstream_proxy_error", 502);
  const result = (await proxy.json()) as {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
  return new Response(result.body || "", {
    status: result.status,
    headers: result.headers || {},
  });
}

export const PROVIDERS = {
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    quota: "https://chatgpt.com/backend-api/wham/usage",
    inference: "https://chatgpt.com/backend-api/codex/responses",
    models: [
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
  },
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorize: "https://claude.ai/oauth/authorize",
    token: "https://api.anthropic.com/v1/oauth/token",
    scope: "org:create_api_key user:profile user:inference",
    quota: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
    inference: "https://api.anthropic.com/v1/messages?beta=true",
    models: [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
    ],
  },
};
export const PRESETS: Record<string, string> = {
  ping: "Reply only OK.",
  hello: "Say hello in one word.",
};
export function oauthProvider(value: string): OAuthProvider {
  if (value !== "claude" && value !== "codex")
    throw new AppError("unsupported_provider");
  return value;
}
export function clientId(provider: OAuthProvider, env: Env) {
  return (
    (provider === "codex" ? env.CODEX_CLIENT_ID : env.CLAUDE_CLIENT_ID) ||
    PROVIDERS[provider].clientId
  );
}
export function redirectURI(provider: OAuthProvider, env: Env) {
  return (
    (provider === "codex" ? env.CODEX_REDIRECT_URI : env.CLAUDE_REDIRECT_URI) ||
    (provider === "codex"
      ? "http://localhost:1455/auth/callback"
      : `${env.APP_ORIGIN}/api/oauth/claude/callback`)
  );
}
export function authURL(
  provider: OAuthProvider,
  env: Env,
  state: string,
  challenge: string,
) {
  const config = PROVIDERS[provider];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId(provider, env),
    redirect_uri: redirectURI(provider, env),
    scope: config.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (provider === "claude") params.set("code", "true");
  else {
    params.set("id_token_add_organizations", "true");
    params.set("codex_cli_simplified_flow", "true");
    params.set("originator", "codex_cli_rs");
  }
  return `${config.authorize}?${params}`;
}
export async function providerJSON(response: Response): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      response.status === 401 || response.status === 403
        ? "reconnect_required"
        : response.status === 429
          ? "provider_rate_limited"
          : `provider_http_${response.status}`,
      502,
      response.status,
    );
  }
  try {
    return JSON.parse(await boundedText(response));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("provider_format_changed", 502);
  }
}
export async function exchange(
  provider: OAuthProvider,
  env: Env,
  code: string,
  verifier: string,
  state: string,
  fetcher: typeof fetch = fetch,
) {
  const [actualCode, codeState] = code.split("#");
  if (codeState && codeState !== state)
    throw new AppError("oauth_state_mismatch", 403);
  const body = {
    grant_type: "authorization_code",
    client_id: clientId(provider, env),
    code: provider === "claude" ? actualCode : code,
    redirect_uri: redirectURI(provider, env),
    code_verifier: verifier,
    ...(provider === "claude" ? { state: codeState || state } : {}),
  };
  let response: Response;
  try {
    response = await upstreamFetch(
      env,
      PROVIDERS[provider].token,
      {
        method: "POST",
        headers: {
          "Content-Type":
            provider === "claude"
              ? "application/json"
              : "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body:
          provider === "claude"
            ? JSON.stringify(body)
            : new URLSearchParams(body).toString(),
      },
      fetcher,
    );
  } catch {
    throw new AppError("oauth_network_error", 502);
  }
  const data = await providerJSON(response);
  return data;
}
export function tokenSecret(data: any, previous?: Secret): Secret {
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new AppError("provider_format_changed", 502);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous?.refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    accountId: previous?.accountId,
  };
}
export async function refresh(
  provider: OAuthProvider,
  env: Env,
  secret: Secret,
  fetcher: typeof fetch = fetch,
) {
  if (!secret.refreshToken) throw new AppError("reconnect_required", 409);
  const response = await upstreamFetch(
    env,
    PROVIDERS[provider].token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
        client_id: clientId(provider, env),
      }),
    },
    fetcher,
  );
  if (response.status === 400) {
    await response.body?.cancel();
    throw new AppError("reconnect_required", 409, 400);
  }
  return tokenSecret(await providerJSON(response), secret);
}
function claims(token: string) {
  try {
    const part = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(part));
  } catch {
    throw new AppError("oauth_identity_unavailable", 502);
  }
}
export function oauthSubject(data: {
  id_token?: string;
  access_token?: string;
}) {
  const subject = claims(data.id_token || data.access_token || "").sub;
  if (typeof subject !== "string" || !subject)
    throw new AppError("oauth_identity_unavailable", 502);
  return subject;
}
export async function identity(
  provider: OAuthProvider,
  data: any,
  secret: Secret,
  fetcher: typeof fetch = fetch,
  env?: Pick<Env, "UPSTREAM_PROXY_URL">,
) {
  if (provider === "codex") {
    // Tokens originate directly from the fixed TLS token endpoint, never browser input.
    const payload = claims(data.id_token || data.access_token),
      auth = payload["https://api.openai.com/auth"] || {};
    const account = auth.chatgpt_account_id || payload.account_id;
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof account !== "string" ||
      !account
    )
      throw new AppError("oauth_identity_unavailable", 502);
    secret.accountId = account;
    return {
      id: `${payload.sub}:${account}`,
      name: String(payload.email || "Codex account").slice(0, 100),
    };
  }
  // 9Router quota profile returns organization.uuid, not account identity. Do not use
  // organization IDs: two unrelated users can share an org and dedup incorrectly.
  // Treat provider token subject as the stable upstream account identity.
  const payload = claims(data.id_token || data.access_token);
  if (typeof payload.sub !== "string" || !payload.sub)
    throw new AppError("oauth_identity_unavailable", 502);
  const profile = await providerJSON(
    await (env
      ? upstreamFetch(
          env,
          "https://api.anthropic.com/api/oauth/profile",
          {
            headers: {
              Authorization: `Bearer ${secret.accessToken}`,
              "anthropic-beta": "oauth-2025-04-20",
              "anthropic-version": "2023-06-01",
              "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
            },
            redirect: "error",
            signal: AbortSignal.timeout(4000),
          },
          fetcher,
        )
      : fetcher("https://api.anthropic.com/api/oauth/profile", {
          headers: {
            Authorization: `Bearer ${secret.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
          },
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        })),
  );
  const email: unknown = payload.email || profile.account?.email;
  return {
    id: payload.sub,
    name: String(email || "Claude account").slice(0, 100),
  };
}
function resetAt(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const date = new Date(
    typeof value === "number" && value < 1e12 ? value * 1000 : value,
  );
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function quotaWindow(value: any, key: string): WindowQuota | null {
  if (!value || typeof value !== "object") return null;
  const used = value[key];
  if (
    used !== undefined &&
    (typeof used !== "number" ||
      !Number.isFinite(used) ||
      used < 0 ||
      used > 100)
  )
    throw new AppError("provider_format_changed", 502);
  return {
    remaining: used === undefined ? null : 100 - used,
    limit: used === undefined ? null : 100,
    resetAt: resetAt(value.reset_at ?? value.resets_at ?? value.resetAt),
  };
}
export function normalizeQuota(provider: OAuthProvider, data: any): QuotaData {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new AppError("provider_format_changed", 502);
  if (provider === "claude") {
    if (!("five_hour" in data) && !("seven_day" in data))
      throw new AppError("provider_format_changed", 502);
    return {
      window5h: quotaWindow(data.five_hour, "utilization"),
      weekly: quotaWindow(data.seven_day, "utilization"),
    };
  }
  const rate =
    data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex;
  if (!rate || typeof rate !== "object")
    throw new AppError("provider_format_changed", 502);
  const windows = [
    rate.primary_window || rate.primary,
    rate.secondary_window || rate.secondary,
  ].filter(Boolean);
  // 9Router treats the provider's primary and secondary windows as session and weekly.
  function select(fallback: number) {
    const window = windows[fallback];
    return quotaWindow(
      window,
      window?.used_percent === undefined ? "percent_used" : "used_percent",
    );
  }
  return { window5h: select(0), weekly: select(1) };
}
export function oauthHeaders(
  provider: OAuthProvider,
  secret: Secret,
): Record<string, string> {
  return provider === "claude"
    ? {
        Authorization: `Bearer ${secret.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":
          "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
        "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
        "Anthropic-Dangerous-Direct-Browser-Access": "true",
        "X-App": "cli",
        Accept: "application/json",
      }
    : {
        Authorization: `Bearer ${secret.accessToken}`,
        Accept: "application/json",
        ...(secret.accountId ? { "ChatGPT-Account-ID": secret.accountId } : {}),
      };
}
export async function fetchQuota(
  provider: OAuthProvider,
  secret: Secret,
  env: Pick<Env, "UPSTREAM_PROXY_URL"> = {},
  fetcher: typeof fetch = fetch,
) {
  return normalizeQuota(
    provider,
    await providerJSON(
      await upstreamFetch(
        env,
        PROVIDERS[provider].quota,
        {
          headers:
            provider === "codex"
              ? {
                  Authorization: `Bearer ${secret.accessToken}`,
                  Accept: "application/json",
                }
              : oauthHeaders(provider, secret),
        },
        fetcher,
      ),
    ),
  );
}
export function inferenceRequest(
  provider: OAuthProvider,
  secret: Secret,
  model: string,
  preset: string,
) {
  const text = PRESETS[preset];
  if (!text || !PROVIDERS[provider].models.includes(model))
    throw new AppError("unsupported_model_or_preset");
  return {
    url: PROVIDERS[provider].inference,
    init: {
      method: "POST",
      headers: {
        ...oauthHeaders(provider, secret),
        "Content-Type": "application/json",
        ...(provider === "codex"
          ? {
              Accept: "text/event-stream",
              originator: "codex_cli_rs",
              "User-Agent": "codex_cli_rs/0.159.0",
              version: "0.159.0",
            }
          : {}),
      },
      body: JSON.stringify(
        provider === "claude"
          ? {
              model,
              max_tokens: 8,
              messages: [{ role: "user", content: text }],
            }
          : {
              model,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text }],
                },
              ],
              instructions: "Be concise.",
              store: false,
              stream: true,
            },
      ),
      redirect: "error" as const,
      signal: AbortSignal.timeout(16000),
    },
  };
}
export async function invoke(
  provider: OAuthProvider,
  secret: Secret,
  model: string,
  preset: string,
  fetcher: typeof fetch = fetch,
  env?: Pick<Env, "UPSTREAM_PROXY_URL">,
) {
  const request = inferenceRequest(provider, secret, model, preset);
  // One attempt only. HTTP 200 alone does not prove a successful inference.
  const response = await (env
    ? upstreamFetch(env, request.url, request.init, fetcher)
    : fetcher(request.url, request.init));
  if (provider === "claude") {
    const data = await providerJSON(response);
    if (
      data.type !== "message" ||
      !Array.isArray(data.content) ||
      !["end_turn", "max_tokens", "stop_sequence"].includes(data.stop_reason)
    )
      throw new AppError("inference_unconfirmed", 502, response.status);
    return;
  }
  if (!response.ok) {
    await providerJSON(response);
    return;
  }
  const contentType = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  // Codex currently labels its SSE response as text/plain;charset=UTF-8.
  if (
    !response.body ||
    !["text/event-stream", "text/plain"].includes(contentType || "")
  )
    throw new AppError("inference_unconfirmed", 502, response.status);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    total = 0,
    completed = false;
  const consume = (frame: string) => {
    const eventName = frame
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const raw = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!raw || raw === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new AppError("inference_unconfirmed", 502);
    }
    const type =
      typeof event.type === "string" ? event.type : eventName;
    if (["response.failed", "response.incomplete", "error"].includes(type))
      throw new AppError("inference_failed", 502);
    if (
      ["response.completed", "response.done"].includes(type) &&
      !["failed", "incomplete"].includes(event.response?.status)
    )
      completed = true;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 262144) throw new AppError("inference_unconfirmed", 502);
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        consume(frame);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed) throw new AppError("inference_unconfirmed", 502);
}
export async function testCustom(
  config: any,
  secret: Secret,
  provider: string,
  env: Env,
  fetcher: typeof fetch = fetch,
) {
  const base = validateEndpoint(config.baseUrl, env);
  await checkPublicDNS(new URL(base).hostname, fetcher);
  const isOpenAI = provider === "openai-compatible";
  const response = await fetcher(`${base}/models`, {
    method: "GET",
    headers: {
      ...secret.headers,
      ...(isOpenAI
        ? { Authorization: `Bearer ${secret.apiKey}` }
        : {
            "x-api-key": secret.apiKey || "",
            "anthropic-version": "2023-06-01",
          }),
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const data = await providerJSON(response);
  if (!Array.isArray(data.data))
    throw new AppError("provider_format_changed", 502);
  return {
    connected: true,
    models: data.data
      .filter((m: any) => typeof m.id === "string")
      .map((m: any) => m.id)
      .slice(0, 100),
  };
}
