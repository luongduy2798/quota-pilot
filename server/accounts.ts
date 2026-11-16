import {
  AppError,
  type Account,
  type Env,
  type OAuthProvider,
  type QuotaData,
  type QuotaRow,
  type Secret,
  classify,
  later,
  now,
  query,
  rows,
  run,
} from "./types";
import {
  decrypt,
  digest,
  encrypt,
  flag,
  randomToken,
  textField,
  validateEndpoint,
  validateHeaders,
  type Session,
} from "./security";
import {
  authURL,
  exchange,
  fetchQuota,
  identity,
  oauthProvider,
  oauthSubject,
  PROVIDERS,
  redirectURI,
  refresh,
  testCustom,
  tokenSecret,
} from "./providers";

export async function account(env: Env, id: string) {
  const value = await query<Account>(
    env,
    "SELECT * FROM accounts WHERE id=?",
    id,
  );
  if (!value) throw new AppError("account_not_found", 404);
  return value;
}
export function publicAccount(value: Account, _env: Env) {
  const {
    id,
    kind,
    provider,
    name,
    enabled,
    status,
    last_refresh,
    last_check,
    created_at,
    updated_at,
  } = value;
  const config = JSON.parse(value.config);
  return {
    id,
    kind,
    provider,
    name,
    enabled: !!enabled,
    status,
    last_refresh,
    last_check,
    created_at,
    updated_at,
    config,
    credentialMask: "••••••••",
    capability:
      kind === "oauth"
        ? "oauth-quota-supported"
        : "manual-or-provider-specific",
    schedulerSupported:
      kind === "oauth" && provider === "codex",
    models:
      kind === "oauth"
        ? PROVIDERS[provider as OAuthProvider].models
        : config.models,
  };
}
export async function credentials(
  env: Env,
  value: Account,
  force = false,
): Promise<Secret> {
  if (!value.enabled) throw new AppError("account_disabled", 409);
  if (value.cooldown_until && value.cooldown_until > now())
    throw new AppError("provider_cooldown", 429);
  let secret = await decrypt<Secret>(value.secret, env, `account:${value.id}`);
  if (value.kind !== "oauth") return secret;
  if (value.status === "reconnect_required")
    throw new AppError("reconnect_required", 409);
  if (
    !force &&
    secret.expiresAt &&
    Date.parse(secret.expiresAt) > Date.now() + 600000
  )
    return secret;
  const lock = randomToken(),
    stamp = now();
  const result = await run(
    env,
    "UPDATE accounts SET refresh_lock=?,refresh_lock_until=? WHERE id=? AND (refresh_lock_until IS NULL OR refresh_lock_until<?)",
    lock,
    later(60000),
    value.id,
    stamp,
  );
  if (!result.meta.changes) throw new AppError("refresh_in_progress", 409);
  try {
    const latest = await account(env, value.id);
    secret = await decrypt<Secret>(latest.secret, env, `account:${value.id}`);
    // A concurrent refresh may have finished between the initial read and our claim.
    if (
      latest.secret !== value.secret ||
      (!force &&
        secret.expiresAt &&
        Date.parse(secret.expiresAt) > Date.now() + 600000)
    )
      return secret;
    const updated = await refresh(oauthProvider(value.provider), env, secret);
    const saved = await run(
      env,
      "UPDATE accounts SET secret=?,last_refresh=?,status=?,updated_at=? WHERE id=? AND refresh_lock=?",
      await encrypt(updated, env, `account:${value.id}`),
      now(),
      "connected",
      now(),
      value.id,
      lock,
    );
    if (!saved.meta.changes) throw new AppError("refresh_conflict", 409);
    return updated;
  } catch (error) {
    // An interrupted refresh may have rotated the token. Reconnect, never replay blindly.
    await run(
      env,
      "UPDATE accounts SET status=?,cooldown_until=? WHERE id=? AND refresh_lock=?",
      classify(error) === "provider_rate_limited"
        ? "error"
        : "reconnect_required",
      later(180000),
      value.id,
      lock,
    );
    throw error;
  } finally {
    await run(
      env,
      "UPDATE accounts SET refresh_lock=NULL,refresh_lock_until=NULL WHERE id=? AND refresh_lock=?",
      value.id,
      lock,
    );
  }
}
function customConfig(body: Record<string, any>) {
  if (
    !Array.isArray(body.models) ||
    !body.models.length ||
    body.models.length > 30 ||
    body.models.some(
      (m: unknown) =>
        typeof m !== "string" || !/^[a-zA-Z0-9._:/@+-]{1,150}$/.test(m),
    )
  )
    throw new AppError("invalid_models");
  return [...new Set(body.models)];
}
export async function saveCustom(
  env: Env,
  body: Record<string, any>,
  current?: Account,
) {
  if (current && current.kind !== "custom") {
    await run(
      env,
      "UPDATE accounts SET name=?,enabled=?,updated_at=? WHERE id=?",
      body.name === undefined ? current.name : textField(body.name, "name"),
      +flag(body.enabled, !!current.enabled),
      now(),
      current.id,
    );
    return;
  }
  const provider = current?.provider || body.provider;
  if (!["openai-compatible", "anthropic-compatible"].includes(provider))
    throw new AppError("unsupported_provider");
  if (body.provider !== undefined && body.provider !== provider)
    throw new AppError("provider_immutable");
  const oldConfig = current ? JSON.parse(current.config) : {};
  const baseUrl = validateEndpoint(body.baseUrl ?? oldConfig.baseUrl, env);
  const models = customConfig({ models: body.models ?? oldConfig.models });
  const previous = current
    ? await decrypt<Secret>(current.secret, env, `account:${current.id}`)
    : {};
  const secret = {
    apiKey: body.apiKey
      ? textField(body.apiKey, "api_key", 4000)
      : previous.apiKey,
    headers:
      body.headers === undefined
        ? previous.headers || {}
        : validateHeaders(body.headers),
  };
  if (!secret.apiKey) throw new AppError("api_key_required");
  const id = current?.id || crypto.randomUUID(),
    stamp = now();
  const config = JSON.stringify({
    baseUrl,
    models,
    headerNames: Object.keys(secret.headers),
  });
  if (current)
    await run(
      env,
      "UPDATE accounts SET name=?,secret=?,config=?,enabled=?,status=?,updated_at=? WHERE id=?",
      textField(body.name ?? current.name, "name"),
      await encrypt(secret, env, `account:${id}`),
      config,
      +flag(body.enabled, !!current.enabled),
      "unchecked",
      stamp,
      id,
    );
  else
    await run(
      env,
      "INSERT INTO accounts (id,kind,provider,name,secret,config,created_at,updated_at,status) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      "custom",
      provider,
      textField(body.name, "name"),
      await encrypt(secret, env, `account:${id}`),
      config,
      stamp,
      stamp,
      "unchecked",
    );
  return id;
}
export async function beginOAuth(
  env: Env,
  provider: OAuthProvider,
  current: Session,
  body: Record<string, any>,
) {
  if (body.accountId) {
    const value = await account(env, body.accountId);
    if (value.provider !== provider || value.kind !== "oauth")
      throw new AppError("account_provider_mismatch");
  }
  const state = randomToken(),
    verifier = randomToken(),
    challenge = (await digest(verifier))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const redirect = new URL(redirectURI(provider, env));
  await run(
    env,
    "INSERT INTO oauth_states (id,provider,session_id,secret,account_id,expires_at) VALUES (?,?,?,?,?,?)",
    state,
    provider,
    current.id,
    await encrypt({ verifier }, env, `oauth:${state}`),
    body.accountId || null,
    later(600000),
  );
  return {
    state,
    authUrl: authURL(provider, env, state, challenge),
    redirectUri: redirectURI(provider, env),
    manualCallback:
      provider === "codex" ||
      redirect.origin !== new URL(env.APP_ORIGIN).origin,
  };
}
export async function finishOAuth(
  env: Env,
  provider: OAuthProvider,
  current: Session,
  body: Record<string, any>,
) {
  const state = textField(body.state, "state", 100);
  let code = textField(body.code, "code", 6000);
  if (code.startsWith("http:") || code.startsWith("https:")) {
    const callback = new URL(code),
      expected = new URL(redirectURI(provider, env));
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.searchParams.get("state") !== state
    )
      throw new AppError("oauth_state_mismatch", 403);
    code = callback.searchParams.get("code") || "";
  }
  if (!code) throw new AppError("oauth_code_required");
  const pending = await query<{ secret: string; account_id: string | null }>(
    env,
    "SELECT secret,account_id FROM oauth_states WHERE id=? AND provider=? AND session_id=? AND expires_at>? AND claimed=0",
    state,
    provider,
    current.id,
    now(),
  );
  if (!pending) throw new AppError("oauth_session_expired", 409);
  const claim = await run(
    env,
    "UPDATE oauth_states SET claimed=1 WHERE id=? AND claimed=0",
    state,
  );
  if (!claim.meta.changes) throw new AppError("oauth_already_used", 409);
  const { verifier } = await decrypt<{ verifier: string }>(
    pending.secret,
    env,
    `oauth:${state}`,
  );
  const data = await exchange(provider, env, code, verifier, state);
  const secret = tokenSecret(data),
    upstream = await identity(provider, data, secret, fetch, env);
  const identityHash = await digest(`${provider}:${upstream.id}`);
  const existing = await query<Account>(
    env,
    "SELECT * FROM accounts WHERE provider=? AND identity=?",
    provider,
    identityHash,
  );
  if (pending.account_id) {
    const target = await account(env, pending.account_id);
    if (target.identity !== identityHash)
      throw new AppError("reconnect_identity_mismatch", 409);
  }
  const identityBytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${provider}:${upstream.id}`),
    ),
  );
  const stableId = `oauth-${Array.from(identityBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  const id = existing?.id || stableId,
    stamp = now();
  const encrypted = await encrypt(secret, env, `account:${id}`);
  if (existing) {
    const result = await run(
      env,
      "UPDATE accounts SET secret=?,status=?,last_refresh=?,updated_at=?,cooldown_until=NULL WHERE id=? AND (refresh_lock_until IS NULL OR refresh_lock_until<?) AND (work_lock_until IS NULL OR work_lock_until<?)",
      encrypted,
      "connected",
      stamp,
      stamp,
      id,
      stamp,
      stamp,
    );
    if (!result.meta.changes)
      throw new AppError("account_busy_reconnect_again", 409);
  } else {
    // Atomic identity constraint prevents duplicate accounts under concurrent logins.
    const result = await run(
      env,
      `INSERT INTO accounts (id,kind,provider,identity,name,secret,created_at,updated_at,last_refresh) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,secret=excluded.secret,status='connected',last_refresh=excluded.last_refresh,updated_at=excluded.updated_at,cooldown_until=NULL
       WHERE (accounts.refresh_lock_until IS NULL OR accounts.refresh_lock_until<?) AND (accounts.work_lock_until IS NULL OR accounts.work_lock_until<?)`,
      id,
      "oauth",
      provider,
      identityHash,
      upstream.name,
      encrypted,
      stamp,
      stamp,
      stamp,
      stamp,
      stamp,
    );
    if (!result.meta.changes)
      throw new AppError("account_busy_reconnect_again", 409);
  }
  return { accountId: id };
}
export async function import9RouterAccounts(env: Env, values: unknown) {
  if (!Array.isArray(values) || values.length > 500)
    throw new AppError("invalid_import");
  const existingCodexIds = new Set<string>();
  for (const existing of await rows<Account>(
    env,
    "SELECT * FROM accounts WHERE provider='codex'",
  )) {
    try {
      const secret = await decrypt<Secret>(
        existing.secret,
        env,
        `account:${existing.id}`,
      );
      if (secret.accountId) existingCodexIds.add(secret.accountId);
    } catch {
      // Fall back to the identity hash for records that cannot be decrypted.
    }
  }
  const imported: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of values) {
    if (!item || typeof item !== "object") throw new AppError("invalid_import");
    const source = item as Record<string, any>,
      data = source.data,
      provider = source.provider || "codex";
    if (provider !== "codex")
      throw new AppError("invalid_import");
    if (
      typeof source.name !== "string" ||
      !data ||
      typeof data.accessToken !== "string" ||
      typeof data.refreshToken !== "string"
    )
      throw new AppError("invalid_import");
    const subject = oauthSubject({
      id_token: data.idToken,
      access_token: data.accessToken,
    });
    const providerAccountId = data.providerSpecificData?.chatgptAccountId;
    if (typeof providerAccountId !== "string" || !providerAccountId)
      throw new AppError("oauth_identity_unavailable", 502);
    const upstreamId = `${subject}:${providerAccountId}`;
    const duplicateKey = `${provider}:${upstreamId}`;
    if (
      seen.has(duplicateKey) ||
      existingCodexIds.has(providerAccountId)
    ) {
      skipped++;
      continue;
    }
    const identityHash = await digest(`${provider}:${upstreamId}`);
    if (
      await query<Account>(
        env,
        "SELECT id FROM accounts WHERE provider=? AND identity=?",
        provider,
        identityHash,
      )
    ) {
      skipped++;
      continue;
    }
    const secret: Secret = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt:
        typeof data.expiresAt === "string" ? data.expiresAt : undefined,
      ...(providerAccountId ? { accountId: providerAccountId } : {}),
    };
    const bytes = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${provider}:${upstreamId}`),
      ),
    );
    const stableId = `oauth-${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    const id = stableId;
    const stamp = now();
    const result = await run(
      env,
      `INSERT INTO accounts (id,kind,provider,identity,name,secret,created_at,updated_at,last_refresh,status)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      id,
      "oauth",
      provider,
      identityHash,
      textField(source.name, "name", 100),
      await encrypt(secret, env, `account:${id}`),
      stamp,
      stamp,
      stamp,
      "connected",
    );
    if (result.meta.changes) {
      seen.add(duplicateKey);
      if (providerAccountId) existingCodexIds.add(providerAccountId);
      imported.push(id);
    } else skipped++;
  }
  return { imported, skipped };
}
export function publicQuota(row: QuotaRow | null, accountId: string) {
  return {
    accountId,
    source: row?.source || "Not available",
    fetchedAt: row?.fetched_at || null,
    attemptedAt: row?.attempted_at || null,
    stale:
      !row?.fetched_at ||
      !!row.error ||
      Date.now() - Date.parse(row.fetched_at) > 300000,
    error: row?.error || null,
    nextPollAt: row?.next_poll_at || null,
    ...(row ? JSON.parse(row.data) : { window5h: null, weekly: null }),
  };
}
export async function quota(
  env: Env,
  value: Account,
  force: false | "manual" | "scheduled" = false,
) {
  const cached = await query<QuotaRow>(
    env,
    "SELECT * FROM quotas WHERE account_id=?",
    value.id,
  );
  if (value.kind !== "oauth") return publicQuota(null, value.id);
  if (cached && cached.next_poll_at > now() && force !== "scheduled")
    return publicQuota(cached, value.id);
  const stamp = now();
  await run(
    env,
    "INSERT OR IGNORE INTO quotas (account_id,attempted_at,source,next_poll_at) VALUES (?,?,?,?)",
    value.id,
    stamp,
    PROVIDERS[oauthProvider(value.provider)].quota,
    stamp,
  );
  const claim = await run(
    env,
    "UPDATE quotas SET poll_lock_until=?,next_poll_at=? WHERE account_id=? AND (?=1 OR next_poll_at<=?) AND (poll_lock_until IS NULL OR poll_lock_until<?)",
    later(30000),
    later(60000),
    value.id,
    +Boolean(force),
    stamp,
    stamp,
  );
  if (!claim.meta.changes)
    return publicQuota(
      await query<QuotaRow>(
        env,
        "SELECT * FROM quotas WHERE account_id=?",
        value.id,
      ),
      value.id,
    );
  try {
    let secret = await credentials(env, value);
    let data: QuotaData;
    try {
      data = await fetchQuota(oauthProvider(value.provider), secret, env);
    } catch (error) {
      // 9Router retries a usage request once with a forced OAuth refresh after
      // an upstream 401/403. Never retry the inference path or loop on failure.
      if (!(error instanceof AppError) || error.code !== "reconnect_required")
        throw error;
      secret = await credentials(env, value, true);
      data = await fetchQuota(oauthProvider(value.provider), secret, env);
    }
    await run(
      env,
      "UPDATE quotas SET fetched_at=?,attempted_at=?,data=?,error=NULL,next_poll_at=?,poll_lock_until=NULL WHERE account_id=?",
      now(),
      now(),
      JSON.stringify(data),
      later(60000),
      value.id,
    );
    await run(
      env,
      "UPDATE accounts SET status=?,last_check=? WHERE id=?",
      "connected",
      now(),
      value.id,
    );
  } catch (error) {
    const code = classify(error),
      cooldown = code === "provider_rate_limited" ? 180000 : 60000;
    await run(
      env,
      "UPDATE quotas SET attempted_at=?,error=?,next_poll_at=?,poll_lock_until=NULL WHERE account_id=?",
      now(),
      code,
      later(cooldown),
      value.id,
    );
    await run(
      env,
      "UPDATE accounts SET status=?,last_check=?,cooldown_until=? WHERE id=?",
      code === "reconnect_required" ? code : "error",
      now(),
      later(cooldown),
      value.id,
    );
  }
  return publicQuota(
    await query<QuotaRow>(
      env,
      "SELECT * FROM quotas WHERE account_id=?",
      value.id,
    ),
    value.id,
  );
}
export async function testAccount(env: Env, value: Account) {
  if (value.kind === "oauth") return quota(env, value);
  try {
    const result = await testCustom(
      JSON.parse(value.config),
      await credentials(env, value),
      value.provider,
      env,
    );
    await run(
      env,
      "UPDATE accounts SET status=?,last_check=? WHERE id=?",
      "connected",
      now(),
      value.id,
    );
    return result;
  } catch (error) {
    await run(
      env,
      "UPDATE accounts SET status=?,last_check=?,cooldown_until=? WHERE id=?",
      "error",
      now(),
      later(60000),
      value.id,
    );
    throw error;
  }
}
export async function allQuotas(env: Env) {
  const accounts = await rows<Account>(
    env,
    "SELECT * FROM accounts ORDER BY created_at",
  );
  const cache = await rows<QuotaRow>(env, "SELECT * FROM quotas");
  return accounts.map((a) =>
    publicQuota(cache.find((q) => q.account_id === a.id) || null, a.id),
  );
}
