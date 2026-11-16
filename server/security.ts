import { AppError, type Env, later, now, query, run } from "./types";

export function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
export function unb64(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
}
export function randomToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function digest(value: string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export async function encrypt(
  value: unknown,
  env: Pick<Env, "ENCRYPTION_KEY">,
  context: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(env.ENCRYPTION_KEY),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}
export async function decrypt<T>(
  value: string,
  env: Pick<Env, "ENCRYPTION_KEY">,
  context: string,
): Promise<T> {
  const [version, iv, cipher] = value.split(".");
  if (version !== "v1") throw new AppError("encrypted_record_invalid", 500);
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(env.ENCRYPTION_KEY),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(iv),
          additionalData: new TextEncoder().encode(context),
        },
        key,
        unb64(cipher),
      ),
    ),
  );
}
export async function passwordMatches(password: string, stored: string) {
  if (stored.startsWith("hmac1:")) {
    const [, salt, expected] = stored.split(":");
    if (!salt || !expected) throw new AppError("server_not_configured", 503);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    let actual = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, unb64(salt)),
    );
    for (let count = 1; count < 1000; count++)
      actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, actual));
    const target = unb64(expected);
    let difference = actual.length ^ target.length;
    actual.forEach((value, index) => {
      difference |= value ^ target[index];
    });
    return difference === 0;
  }
  const [iterations, salt, expected] = stored.split(":");
  if (+iterations < 100000 || +iterations > 600000 || !salt || !expected)
    throw new AppError("server_not_configured", 503);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const block = new Uint8Array([...unb64(salt), 0, 0, 0, 1]);
  let value = new Uint8Array(await crypto.subtle.sign("HMAC", key, block));
  const actual = new Uint8Array(value);
  for (let count = 1; count < +iterations; count++) {
    value = new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
    for (let index = 0; index < actual.length; index++) actual[index] ^= value[index];
  }
  const target = unb64(expected);
  let difference = actual.length ^ target.length;
  actual.forEach((v, i) => {
    difference |= v ^ target[i];
  });
  return difference === 0;
}
export interface Session {
  id: string;
  csrf: string;
  expires_at: string;
}
export async function session(request: Request, env: Env) {
  const raw = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)qp_session=([A-Za-z0-9_-]{43})/)?.[1];
  if (!raw) throw new AppError("unauthenticated", 401);
  const found = await query<Session>(
    env,
    "SELECT * FROM sessions WHERE id=? AND expires_at>?",
    await digest(raw + env.SESSION_SECRET),
    now(),
  );
  if (!found) throw new AppError("unauthenticated", 401);
  return found;
}
export function originCheck(request: Request, env: Env) {
  if (request.headers.get("Origin") !== new URL(env.APP_ORIGIN).origin)
    throw new AppError("invalid_origin", 403);
}
export function csrfCheck(request: Request, current: Session) {
  if (request.headers.get("X-CSRF-Token") !== current.csrf)
    throw new AppError("invalid_csrf", 403);
}
export function sessionCookie(token: string, env: Env, expired = false) {
  return `qp_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${expired ? 0 : 43200}${env.APP_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
}
export async function login(request: Request, env: Env, password: string) {
  const id = await digest(
    (request.headers.get("CF-Connecting-IP") || "local") + env.SESSION_SECRET,
  );
  const limit = await query<{ attempts: number; expires_at: string }>(
    env,
    "SELECT * FROM login_limits WHERE id=?",
    id,
  );
  if (limit && limit.expires_at > now() && limit.attempts >= 8)
    throw new AppError("login_rate_limited", 429);
  await run(
    env,
    `INSERT INTO login_limits VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN expires_at<? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END`,
    id,
    later(900000),
    now(),
    now(),
  );
  if (!(await passwordMatches(password, env.ADMIN_PASSWORD_HASH)))
    throw new AppError("invalid_password", 401);
  const token = randomToken(),
    csrf = randomToken();
  await run(
    env,
    "INSERT INTO sessions VALUES (?,?,?)",
    await digest(token + env.SESSION_SECRET),
    csrf,
    later(43200000),
  );
  return { token, csrf };
}
export async function jsonBody(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new AppError("json_required", 415);
  const text = await boundedText(request, 24000);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw 0;
    return data;
  } catch {
    throw new AppError("invalid_json");
  }
}
export async function boundedText(
  source: { body: ReadableStream<Uint8Array> | null },
  maximum = 262144,
) {
  const reader = source.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new AppError("response_too_large", 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export function textField(value: unknown, name: string, max = 100) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new AppError(`invalid_${name}`);
  return value.trim();
}
export function flag(value: unknown, fallback = true) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new AppError("invalid_boolean");
  return value;
}
export function validateHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 10
  )
    throw new AppError("invalid_headers");
  const result: Record<string, string> = {};
  for (const [key, content] of Object.entries(value)) {
    if (
      !/^[a-zA-Z0-9-]{1,64}$/.test(key) ||
      /^(host|cookie|authorization|x-api-key|content-length|connection|transfer-encoding|proxy-.*|cf-.*|x-forwarded-.*|forwarded)$/i.test(
        key,
      ) ||
      typeof content !== "string" ||
      content.length > 2000 ||
      /[^\x20-\x7e]/.test(content)
    )
      throw new AppError("invalid_headers");
    result[key] = content;
  }
  return result;
}

// ponytail: custom destinations require an operator-owned exact host allowlist;
// add a controlled egress gateway if arbitrary tenant-supplied hosts become necessary.
export function validateEndpoint(
  value: unknown,
  env: Pick<Env, "CUSTOM_PROVIDER_HOSTS">,
) {
  let url: URL;
  try {
    url = new URL(textField(value, "base_url", 1000));
  } catch {
    throw new AppError("invalid_base_url");
  }
  const host = url.hostname.toLowerCase();
  const allow = (env.CUSTOM_PROVIDER_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== "443") ||
    !allow.includes(host) ||
    !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  )
    throw new AppError("endpoint_not_allowed");
  return url.href.replace(/\/$/, "");
}
function publicIPv4(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return !(
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && [0, 2, 168].includes(p[1])) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 198 && [18, 19, 51].includes(p[1])) ||
    (p[0] === 203 && p[1] === 0)
  );
}
export async function checkPublicDNS(
  host: string,
  fetcher: typeof fetch = fetch,
) {
  for (const type of ["A", "AAAA"]) {
    const response = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { Accept: "application/dns-json" },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) throw new AppError("dns_verification_failed", 502);
    const data = JSON.parse(await boundedText(response));
    if (data.Status !== 0) throw new AppError("dns_verification_failed", 502);
    const addresses = (data.Answer || []).filter(
      (a: any) => a.type === (type === "A" ? 1 : 28),
    );
    if (type === "A" && !addresses.length)
      throw new AppError("public_ipv4_required");
    for (const address of addresses) {
      const ip = String(address.data).toLowerCase();
      if (
        type === "A"
          ? !publicIPv4(ip)
          : !/^[23][0-9a-f]{3}:/.test(ip) ||
            ip.startsWith("2001:db8:") ||
            ip.startsWith("2001:0:") ||
            ip.startsWith("2002:")
      )
        throw new AppError("private_destination_blocked");
    }
  }
}
