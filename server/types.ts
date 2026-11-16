export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  ADMIN_PASSWORD_HASH: string;
  ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  DEFAULT_TIMEZONE?: string;
  CUSTOM_PROVIDER_HOSTS?: string;
  CLAUDE_SCHEDULER_ENABLED?: string;
  CODEX_REDIRECT_URI?: string;
  CLAUDE_REDIRECT_URI?: string;
  CODEX_CLIENT_ID?: string;
  CLAUDE_CLIENT_ID?: string;
  UPSTREAM_PROXY_URL?: string;
}
export type OAuthProvider = "claude" | "codex";
export type Provider =
  OAuthProvider | "openai-compatible" | "anthropic-compatible";
export interface Secret {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}
export interface Account {
  id: string;
  kind: "oauth" | "custom";
  provider: Provider;
  identity: string | null;
  name: string;
  enabled: number;
  status: string;
  secret: string;
  config: string;
  last_refresh: string | null;
  last_check: string | null;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
}
export interface WindowQuota {
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
}
export interface QuotaData {
  window5h: WindowQuota | null;
  weekly: WindowQuota | null;
}
export interface QuotaRow {
  account_id: string;
  fetched_at: string | null;
  attempted_at: string;
  source: string;
  data: string;
  error: string | null;
  next_poll_at: string;
}
export interface Schedule {
  id: string;
  name: string;
  account_id: string;
  model: string;
  local_time: string;
  timezone: string;
  weekdays: string;
  enabled: number;
  skip_active: number;
  preset: string;
  next_run: string;
  created_at: string;
  updated_at: string;
}
export interface Execution {
  id: string;
  schedule_id: string | null;
  account_id: string | null;
  schedule_name: string;
  occurrence_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: "running" | "success" | "failed" | "skipped" | "missed";
  model: string;
  error_code: string | null;
  http_status: number | null;
  quota_before: string | null;
  quota_after: string | null;
  manual_key: string | null;
}
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public httpStatus: number | null = null,
  ) {
    super(code);
  }
}
export const now = () => new Date().toISOString();
export const later = (ms: number) => new Date(Date.now() + ms).toISOString();
export const query = <T>(env: Env, sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
export const rows = async <T>(env: Env, sql: string, ...args: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
export const run = (env: Env, sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .run();
export function classify(error: unknown) {
  return error instanceof AppError ? error.code : "network_or_format_error";
}
