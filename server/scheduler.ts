import {
  AppError,
  type Account,
  type Env,
  type Execution,
  type QuotaData,
  type Schedule,
  classify,
  later,
  now,
  query,
  rows,
  run,
} from "./types";
import { account, credentials, quota } from "./accounts";
import { flag, textField } from "./security";
import { invoke, oauthProvider, PRESETS, PROVIDERS } from "./providers";
import {
  DEFAULT_TIMEZONE,
  nextOccurrence,
  validateTime,
  validateTimezone,
  validateWeekdays,
} from "./time";

export async function saveSchedule(
  env: Env,
  body: Record<string, any>,
  current?: Schedule,
) {
  const target = await account(
    env,
    body.accountId ?? current?.account_id ?? "",
  );
  if (target.kind !== "oauth") throw new AppError("oauth_account_required");
  const enabled = flag(body.enabled, current ? !!current.enabled : true);
  if (enabled && !target.enabled) throw new AppError("account_disabled");
  const model = textField(body.model ?? current?.model, "model", 150);
  if (!PROVIDERS[oauthProvider(target.provider)].models.includes(model))
    throw new AppError("unsupported_model");
  const name = textField(body.name ?? current?.name, "name");
  const time = validateTime(body.localTime ?? current?.local_time);
  const timezone = validateTimezone(
    body.timezone ??
      current?.timezone ??
      env.DEFAULT_TIMEZONE ??
      DEFAULT_TIMEZONE,
  );
  const weekdays = validateWeekdays(
    body.weekdays ??
      (current ? JSON.parse(current.weekdays) : [0, 1, 2, 3, 4, 5, 6]),
  );
  const preset = body.preset ?? current?.preset ?? "ping";
  if (!Object.hasOwn(PRESETS, preset)) throw new AppError("invalid_preset");
  const skip = flag(body.skipIfActive, current ? !!current.skip_active : false);
  const id = current?.id || crypto.randomUUID(),
    stamp = now();
  const next = nextOccurrence(time, timezone, weekdays, new Date());
  if (current) {
    if (
      await query(
        env,
        "SELECT id FROM executions WHERE schedule_id=? AND status='running'",
        current.id,
      )
    )
      throw new AppError("schedule_busy", 409);
    await run(
      env,
      "UPDATE schedules SET name=?,account_id=?,model=?,local_time=?,timezone=?,weekdays=?,enabled=?,skip_active=?,preset=?,next_run=?,updated_at=? WHERE id=?",
      name,
      target.id,
      model,
      time,
      timezone,
      JSON.stringify(weekdays),
      +enabled,
      +skip,
      preset,
      next,
      stamp,
      id,
    );
  } else
    await run(
      env,
      "INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      name,
      target.id,
      model,
      time,
      timezone,
      JSON.stringify(weekdays),
      +enabled,
      +skip,
      preset,
      next,
      stamp,
      stamp,
    );
  return id;
}
export function publicSchedule(value: Schedule) {
  return {
    ...value,
    accountId: value.account_id,
    localTime: value.local_time,
    weekdays: JSON.parse(value.weekdays),
    enabled: !!value.enabled,
    skipIfActive: !!value.skip_active,
    nextRunAtUtc: value.next_run,
  };
}
export async function schedule(env: Env, id: string) {
  const found = await query<Schedule>(
    env,
    "SELECT * FROM schedules WHERE id=?",
    id,
  );
  if (!found) throw new AppError("schedule_not_found", 404);
  return found;
}
export async function claimOccurrence(
  env: Env,
  value: Schedule,
  clock = new Date(),
) {
  const stamp = clock.toISOString(),
    id = crypto.randomUUID();
  const missed = clock.getTime() - Date.parse(value.next_run) > 300000;
  const next = nextOccurrence(
    value.local_time,
    value.timezone,
    JSON.parse(value.weekdays),
    clock,
  );
  // D1 batch is transactional. Only one replica inserts; advance before network I/O.
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO executions (id,schedule_id,account_id,schedule_name,occurrence_at,started_at,finished_at,status,model,error_code)
      SELECT ?,id,account_id,name,next_run,?,?,?,model,? FROM schedules WHERE id=? AND enabled=1 AND next_run=? AND next_run<=?`,
    ).bind(
      id,
      missed ? null : stamp,
      missed ? stamp : null,
      missed ? "missed" : "running",
      missed ? "outside_grace_period" : null,
      value.id,
      value.next_run,
      stamp,
    ),
    env.DB.prepare(
      "UPDATE schedules SET next_run=? WHERE id=? AND next_run=? AND enabled=1",
    ).bind(next, value.id, value.next_run),
  ]);
  return result[0].meta.changes
    ? query<Execution>(env, "SELECT * FROM executions WHERE id=?", id)
    : null;
}
async function finish(
  env: Env,
  execution: Execution,
  status: Execution["status"],
  error: string | null = null,
  httpStatus: number | null = null,
  before: unknown = null,
  after: unknown = null,
) {
  await run(
    env,
    "UPDATE executions SET status=?,finished_at=?,error_code=?,http_status=?,quota_before=?,quota_after=? WHERE id=? AND status='running'",
    status,
    now(),
    error,
    httpStatus,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    execution.id,
  );
}
export async function execute(env: Env, execution: Execution, value: Schedule) {
  let locked: Account | null = null,
    before: any = null,
    after: any = null;
  try {
    const target = await account(env, value.account_id);
    if (!target.enabled || target.kind !== "oauth") {
      await finish(
        env,
        execution,
        "skipped",
        "account_disabled_or_unsupported",
      );
      return;
    }
    if (target.cooldown_until && target.cooldown_until > now()) {
      await finish(env, execution, "skipped", "provider_cooldown");
      return;
    }
    if (!PROVIDERS[oauthProvider(target.provider)].models.includes(value.model))
      throw new AppError("unsupported_model");
    const claim = await run(
      env,
      "UPDATE accounts SET work_lock=?,work_lock_until=? WHERE id=? AND (work_lock_until IS NULL OR work_lock_until<?)",
      execution.id,
      later(90000),
      target.id,
      now(),
    );
    if (!claim.meta.changes) {
      await finish(env, execution, "skipped", "account_busy");
      return;
    }
    locked = target;
    before = await quota(env, target, "scheduled");
    if (!before.stale) {
      const data = before as QuotaData;
      if (
        [data.window5h, data.weekly].some(
          (q) =>
            q?.remaining !== null &&
            q?.remaining !== undefined &&
            q.remaining <= 0 &&
            q.resetAt &&
            Date.parse(q.resetAt) > Date.now(),
        )
      ) {
        await finish(
          env,
          execution,
          "skipped",
          "quota_exhausted",
          null,
          before,
        );
        return;
      }
      if (
        value.skip_active &&
        data.window5h?.remaining !== null &&
        data.window5h?.remaining !== undefined &&
        data.window5h.remaining < 100 &&
        data.window5h.resetAt &&
        Date.parse(data.window5h.resetAt) > Date.now()
      ) {
        await finish(
          env,
          execution,
          "skipped",
          "verified_active_window",
          null,
          before,
        );
        return;
      }
    }
    if (before.error) {
      await finish(
        env,
        execution,
        "skipped",
        "quota_check_unavailable",
        null,
        before,
      );
      return;
    }
    // Refresh may have updated the stored credentials; resolve them again before inference.
    const secret = await credentials(env, await account(env, target.id));
    await invoke(
      oauthProvider(target.provider),
      secret,
      value.model,
      value.preset,
      fetch,
      env,
    );
    after = await quota(env, await account(env, target.id), "scheduled");
    await finish(env, execution, "success", null, 200, before, after);
  } catch (error) {
    const code = classify(error);
    if (
      locked &&
      error instanceof AppError &&
      [401, 403, 429].includes(error.httpStatus || 0)
    )
      await run(
        env,
        "UPDATE accounts SET status=?,cooldown_until=? WHERE id=?",
        code === "reconnect_required" ? code : "error",
        later(180000),
        locked.id,
      );
    await finish(
      env,
      execution,
      "failed",
      code,
      error instanceof AppError ? error.httpStatus : null,
      before,
      after,
    );
  } finally {
    if (locked)
      await run(
        env,
        "UPDATE accounts SET work_lock=NULL,work_lock_until=NULL WHERE id=? AND work_lock=?",
        locked.id,
        execution.id,
      );
  }
}
export async function manualExecution(env: Env, value: Schedule, key: string) {
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(key))
    throw new AppError("idempotency_key_required");
  const manualKey = `${value.id}:${key}`,
    id = crypto.randomUUID(),
    stamp = now();
  const existing = await query<Execution>(
    env,
    "SELECT * FROM executions WHERE manual_key=?",
    manualKey,
  );
  if (existing) return { execution: existing, claimed: false };
  // Persisted cooldown protects against different keys, repeated clicks and restarts.
  const result = await run(
    env,
    `INSERT OR IGNORE INTO executions (id,schedule_id,account_id,schedule_name,occurrence_at,started_at,status,model,manual_key)
    SELECT ?,id,account_id,name,?,?,'running',model,? FROM schedules WHERE id=? AND NOT EXISTS (
      SELECT 1 FROM executions WHERE account_id=? AND (status='running' OR started_at>?)
    )`,
    id,
    stamp,
    stamp,
    manualKey,
    value.id,
    value.account_id,
    new Date(Date.now() - 60000).toISOString(),
  );
  if (!result.meta.changes) {
    const duplicate = await query<Execution>(
      env,
      "SELECT * FROM executions WHERE manual_key=?",
      manualKey,
    );
    if (duplicate) return { execution: duplicate, claimed: false };
    throw new AppError("run_rate_limited_or_busy", 429);
  }
  return {
    execution: (await query<Execution>(
      env,
      "SELECT * FROM executions WHERE id=?",
      id,
    ))!,
    claimed: true,
  };
}
export async function tick(env: Env, clock = new Date()) {
  const stamp = clock.toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE executions SET status='failed',finished_at=?,error_code='interrupted_outcome_unknown_no_retry' WHERE status='running' AND started_at<?",
    ).bind(stamp, new Date(clock.getTime() - 120000).toISOString()),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(stamp),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(stamp),
    env.DB.prepare("DELETE FROM login_limits WHERE expires_at<?").bind(stamp),
  ]);
  // ponytail: two occurrences per minute keep free-tier subrequests bounded.
  // Use a paid queue worker if substantially higher schedule density is needed.
  const due = await rows<Schedule>(
    env,
    "SELECT * FROM schedules WHERE enabled=1 AND next_run<=? ORDER BY next_run LIMIT 2",
    stamp,
  );
  await Promise.all(
    due.map(async (value) => {
      const execution = await claimOccurrence(env, value, clock);
      if (execution?.status === "running") await execute(env, execution, value);
    }),
  );
}
