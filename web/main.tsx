import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Account = {
  id: string;
  name: string;
  kind: string;
  provider: string;
  status: string;
  enabled: boolean;
  credentialMask: string;
  last_check: string | null;
  last_refresh: string | null;
  capability: string;
  models: string[];
  schedulerSupported: boolean;
  config: { baseUrl?: string; models?: string[]; headerNames?: string[] };
};
type WindowQuota = {
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
};
type Quota = {
  accountId: string;
  window5h: WindowQuota | null;
  weekly: WindowQuota | null;
  stale: boolean;
  fetchedAt: string | null;
  attemptedAt: string | null;
  source: string;
  error: string | null;
};
type Schedule = {
  id: string;
  name: string;
  accountId: string;
  model: string;
  localTime: string;
  timezone: string;
  weekdays: number[];
  enabled: boolean;
  skipIfActive: boolean;
  preset: string;
  nextRunAtUtc: string;
  last_status: string | null;
};
type Execution = {
  id: string;
  schedule_id: string | null;
  account_id: string | null;
  schedule_name: string;
  occurrence_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  model: string;
  error_code: string | null;
  http_status: number | null;
  quota_before: string | null;
  quota_after: string | null;
};
type PendingOAuth = {
  provider: string;
  accountId?: string;
  state: string;
  authUrl: string;
  redirectUri: string;
  manualCallback: boolean;
};
const providerName = (id: string) =>
  ({
    codex: "Codex",
    "openai-compatible": "OpenAI-compatible",
    "anthropic-compatible": "Anthropic-compatible",
  })[id] || id;
const days = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const zones = [
  ...new Set([
    "Asia/Ho_Chi_Minh",
    "UTC",
    ...Intl.supportedValuesOf("timeZone"),
  ]),
];
let csrf = "";
async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: any = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(data.error || "request_failed");
  }
  return data;
}
function Badge({
  children,
  status = "",
}: {
  children: React.ReactNode;
  status?: string;
}) {
  return (
    <span
      className={`badge ${["connected", "success"].includes(status) ? "good" : ["error", "failed", "reconnect_required", "missed"].includes(status) ? "bad" : ""}`}
    >
      {children}
    </span>
  );
}
function IconButton({
  label,
  children,
  disabled,
  onClick,
  danger = false,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-action ${danger ? "danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`switch ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      onCancel={close}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button className="icon-button" aria-label="Đóng" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const oauthPopup = useRef<Window | null>(null);
  const importFile = useRef<HTMLInputElement>(null);
  const [authenticated, setAuthenticated] = useState(false),
    [loading, setLoading] = useState(true),
    [password, setPassword] = useState("");
  const [tab, setTab] = useState("Accounts"),
    [accounts, setAccounts] = useState<Account[]>([]),
    [quotas, setQuotas] = useState<Quota[]>([]),
    [schedules, setSchedules] = useState<Schedule[]>([]),
    [executions, setExecutions] = useState<Execution[]>([]);
  const [timezone, setTimezone] = useState(
    localStorage.getItem("qp_timezone") || "Asia/Ho_Chi_Minh",
  );
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [localImportEnabled, setLocalImportEnabled] = useState(false),
    [clock, setClock] = useState(Date.now());
  const [custom, setCustom] = useState<Account | "new" | null>(null),
    [editSchedule, setEditSchedule] = useState<Schedule | "new" | null>(null),
    [logs, setLogs] = useState<{
      title: string;
      scheduleId?: string;
      accountId?: string;
    } | null>(null);
  const [oauth, setOAuth] = useState<PendingOAuth | null>(() => {
      try {
        return JSON.parse(sessionStorage.getItem("qp_oauth") || "null");
      } catch {
        return null;
      }
    }),
    [callback, setCallback] = useState("");
  async function reload() {
    const [a, q, s, e] = await Promise.all([
      api<Account[]>("/accounts"),
      api<Quota[]>("/quotas"),
      api<Schedule[]>("/schedules"),
      api<Execution[]>("/executions"),
    ]);
    setAccounts(a);
    setQuotas(q);
    setSchedules(s);
    setExecutions(e);
  }
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const state = hash.get("state");
    if (hash.get("oauth") && state) {
      window.opener?.postMessage(
        {
          type: "quota-pilot-oauth",
          state,
          error: hash.get("error"),
        },
        window.location.origin,
      );
      if (window.opener) window.close();
      else history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  async function action(work: () => Promise<unknown>, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await reload();
      if (message) setNotice(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function import9RouterFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      setError("File DB vượt quá giới hạn 25 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let imported = 0,
        skipped = 0;
      if (file.name.toLowerCase().endsWith(".json")) {
        const backup = JSON.parse(await file.text());
        if (!Array.isArray(backup.providerConnections))
          throw new Error("invalid_9router_backup");
        const candidates = backup.providerConnections.flatMap((row: any) => {
          if (row?.authType !== "oauth" || row.provider !== "codex")
            return [];
          const data =
            typeof row.data === "string"
              ? JSON.parse(row.data)
              : row.data && typeof row.data === "object"
                ? row.data
                : row;
          return typeof data.accessToken === "string" &&
            typeof data.refreshToken === "string"
            ? [
                {
                  provider: row.provider,
                  name: row.name || row.email || `${row.provider} account`,
                  data: {
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresAt: data.expiresAt,
                    idToken: data.idToken,
                    providerSpecificData: data.providerSpecificData,
                  },
                },
              ]
            : [];
        });
        if (!candidates.length)
          throw new Error("no_supported_oauth_accounts");
        const result = await api<{ imported: string[]; skipped: number }>(
          "/accounts/import-9router",
          "POST",
          { accounts: candidates },
        );
        imported = result.imported.length;
        skipped = result.skipped;
      } else {
        if (!localImportEnabled) throw new Error("local_import_unavailable");
        const response = await fetch("/api/accounts/import-9router-file", {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.sqlite3",
            "X-CSRF-Token": csrf,
          },
          body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "import_failed");
        imported = result.imported.length;
        skipped = result.skipped;
      }
      await reload();
      setNotice(
        `Đã nhập ${imported} tài khoản mới; bỏ qua ${skipped} tài khoản đã có.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const expired = () => {
      setAuthenticated(false);
      csrf = "";
    };
    window.addEventListener("session-expired", expired);
    api<{ csrf: string; localImportEnabled: boolean }>("/session")
      .then(async (current) => {
        csrf = current.csrf;
        setLocalImportEnabled(current.localImportEnabled);
        setAuthenticated(true);
        await reload();
      })
      .catch((err) => {
        if (err.message !== "unauthenticated") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(
      () => {
        reload().catch((err) => setError(err.message));
      },
      executions.some((e) => e.status === "running") ? 4000 : 30000,
    );
    return () => clearInterval(timer);
  }, [authenticated, executions.some((e) => e.status === "running")]);
  useEffect(() => {
    if (!authenticated || tab !== "Quota Tracker") return;
    const refresh = () => {
      Promise.all(
        accounts
          .filter((a) => a.kind === "oauth" && a.enabled)
          .map((a) => api(`/quotas/${a.id}/refresh`, "POST", {})),
      )
        .then(reload)
        .catch((err) => setError(err.message));
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, [
    authenticated,
    tab,
    accounts.map((a) => `${a.id}:${a.enabled}`).join(","),
  ]);
  function format(value: string | null, zone = timezone) {
    if (!value) return "Chưa có";
    return new Intl.DateTimeFormat("vi-VN", {
      timeZone: zone,
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(value));
  }
  function countdown(value: string | null) {
    if (!value) return "Unknown";
    const seconds = Math.max(0, Math.ceil((Date.parse(value) - clock) / 1000));
    if (!seconds) return "Đã đến mốc reset · cần kiểm tra";
    if (seconds >= 86400) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      return `${days}d ${hours}h`;
    }
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  function quotaTone(window: WindowQuota | null) {
    if (!window || window.remaining == null) return "unknown";
    return window.remaining > 70
      ? "good"
      : window.remaining >= 30
        ? "warn"
        : "bad";
  }
  async function connect(provider: string, accountId?: string) {
    const popup = window.open(
      "about:blank",
      "quota-pilot-oauth",
      "popup=yes,width=560,height=760",
    );
    if (!popup) {
      setError("Hãy cho phép popup để đăng nhập OAuth.");
      return;
    }
    oauthPopup.current = popup;
    await action(async () => {
      const pending = {
        ...(await api<PendingOAuth>(`/oauth/${provider}/start`, "POST", {
          accountId,
        })),
        provider,
        accountId,
      };
      setOAuth(pending);
      setCallback("");
      sessionStorage.setItem("qp_oauth", JSON.stringify(pending));
      popup.location.href = pending.authUrl;
    });
  }
  useEffect(() => {
    if (!oauth) return;
    const completed = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== oauthPopup.current ||
        event.data?.type !== "quota-pilot-oauth" ||
        event.data.state !== oauth.state
      )
        return;
      if (event.data.error) {
        closeOAuth();
        setError(event.data.error);
      } else {
        closeOAuth();
        setNotice("Đã kết nối OAuth.");
        void reload().catch((err) => setError(err.message));
      }
    };
    window.addEventListener("message", completed);
    return () => window.removeEventListener("message", completed);
  }, [oauth]);
  function closeOAuth() {
    oauthPopup.current?.close();
    oauthPopup.current = null;
    setOAuth(null);
    setCallback("");
    sessionStorage.removeItem("qp_oauth");
  }
  if (loading)
    return (
      <div className="login">
        <p>Đang tải Quota Pilot…</p>
      </div>
    );
  if (!authenticated)
    return (
      <main className="login">
        <form
          className="login-card"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              const result = await api<{ csrf: string }>("/login", "POST", {
                password,
              });
              csrf = result.csrf;
              setPassword("");
              await reload();
              setAuthenticated(true);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="wordmark">
            q<span>p</span>
          </span>
          <div className="eyebrow">PRIVATE WORKSPACE</div>
          <h1>Quota Pilot</h1>
          <p>
            Quản lý tài khoản. Theo dõi quota.
            <br />
            Lên lịch từ server.
          </p>
          <label>
            Mật khẩu quản trị
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Đang đăng nhập…" : "Đăng nhập"}
          </button>
        </form>
      </main>
    );
  function accountCard(a: Account) {
    return (
      <article
        className={`account-card ${a.enabled ? "is-enabled" : ""}`}
        key={a.id}
      >
        <div className="compact-card-head">
          <div
            className="provider-icon"
          >
            {a.provider === "codex" ? "Cx" : "API"}
          </div>
          <div className="grow">
            <h3>{a.name}</h3>
            <span className="muted">{providerName(a.provider)}</span>
          </div>
          <Badge status={a.enabled ? a.status : ""}>
            {a.enabled ? a.status : "disabled"}
          </Badge>
          <Switch
            checked={a.enabled}
            disabled={busy}
            label={a.enabled ? "Disable account" : "Enable account"}
            onChange={() =>
              action(() =>
                api(`/accounts/${a.id}`, "PATCH", { enabled: !a.enabled }),
              )
            }
          />
        </div>
        <div className="compact-actions">
          {a.kind === "oauth" ? (
            <IconButton
              label="Reconnect"
              disabled={busy}
              onClick={() => connect(a.provider, a.id)}
            >
              ⇄
            </IconButton>
          ) : (
            <IconButton label="Edit provider" onClick={() => setCustom(a)}>
              ✎
            </IconButton>
          )}
          <IconButton
            label="Test connection"
            disabled={busy || !a.enabled}
            onClick={() => {
              if (
                a.provider === "anthropic-compatible" &&
                !confirm(
                  "Anthropic-compatible test calls GET /models to verify connectivity. Continue?",
                )
              )
                return;
              action(
                () => api(`/accounts/${a.id}/test`, "POST", {}),
                "Đã kiểm tra kết nối. Xem trạng thái tài khoản.",
              );
            }}
          >
            ✓
          </IconButton>
          {a.kind === "oauth" && (
            <IconButton
              label="Refresh token"
              disabled={busy || !a.enabled}
              onClick={() =>
                action(
                  () => api(`/accounts/${a.id}/refresh`, "POST", {}),
                  "Đã refresh token.",
                )
              }
            >
              ↻
            </IconButton>
          )}
          <IconButton
            label="Delete account"
            danger
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  `Xóa ${a.name}? Lịch liên quan sẽ bị xóa. Lịch sử đã chạy được giữ lại.`,
                )
              )
                action(() => api(`/accounts/${a.id}`, "DELETE"));
            }}
          >
            ×
          </IconButton>
        </div>
      </article>
    );
  }
  return (
    <div className="app-shell">
      <header>
        <a className="brand" href="/" aria-label="Quota Pilot">
          <span className="wordmark small">
            q<span>p</span>
          </span>
          <div>
            Quota Pilot<small>SUBSCRIPTION WORKSPACE</small>
          </div>
        </a>
        <div className="header-right">
          <span className="runtime">
            <i /> Server scheduler
          </span>
          <button
            onClick={() =>
              action(async () => {
                await api("/logout", "POST", {});
                setAuthenticated(false);
              })
            }
          >
            Đăng xuất
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">CONTROL CENTER</div>
            <h1>Chủ động với quota.</h1>
            <p>Tài khoản riêng biệt. Dữ liệu thực. Lịch chạy từ server.</p>
          </div>
          <label className="timezone">
            Múi giờ hiển thị
            <select
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                localStorage.setItem("qp_timezone", e.target.value);
              }}
            >
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="stats">
          <div>
            <span>TÀI KHOẢN</span>
            <strong>
              {accounts.length.toString().padStart(2, "0")}
              <small>{accounts.filter((a) => a.enabled).length} đang bật</small>
            </strong>
          </div>
          <div>
            <span>LỊCH ĐANG BẬT</span>
            <strong>
              {schedules
                .filter((s) => s.enabled)
                .length.toString()
                .padStart(2, "0")}
              <small>server-side · mỗi phút</small>
            </strong>
          </div>
          <div>
            <span>LẦN CHẠY GẦN NHẤT</span>
            <strong className="last-status">
              {executions[0]?.status || "Chưa có"}
              <small>
                {executions[0]
                  ? format(executions[0].occurrence_at)
                  : "Tạo lịch đầu tiên để bắt đầu"}
              </small>
            </strong>
          </div>
        </div>
        <nav aria-label="Các tab" role="tablist">
          {["Accounts", "Quota Tracker", "Scheduler"].map((name, index) => (
            <button
              role="tab"
              aria-selected={tab === name}
              aria-controls={`panel-${index}`}
              id={`tab-${index}`}
              tabIndex={tab === name ? 0 : -1}
              key={name}
              onKeyDown={(event) => {
                if (
                  ["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
                  setTab(["Accounts", "Quota Tracker", "Scheduler"][next]);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
              className={tab === name ? "selected" : ""}
              onClick={() => {
                setTab(name);
                setNotice("");
              }}
            >
              {name}
              <span>{index === 2 ? schedules.length : accounts.length}</span>
            </button>
          ))}
        </nav>
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button aria-label="Đóng lỗi" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            {notice}
            <button aria-label="Đóng thông báo" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        <section
          role="tabpanel"
          id={`panel-${["Accounts", "Quota Tracker", "Scheduler"].indexOf(tab)}`}
          aria-labelledby={`tab-${["Accounts", "Quota Tracker", "Scheduler"].indexOf(tab)}`}
        >
          {tab === "Accounts" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>OAuth Providers</h2>
                  <p>
                    Kết nối Codex hoặc nhập từ file DB 9Router.
                  </p>
                </div>
                <div className="account-import">
                  <Badge>01 OAuth provider</Badge>
                  <input
                    ref={importFile}
                    type="file"
                    accept=".json,.sqlite,.sqlite3,.db,application/json,application/vnd.sqlite3"
                    hidden
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void import9RouterFile(file);
                    }}
                  />
                  <button
                    disabled={busy}
                    title={
                      localImportEnabled
                        ? "Nhập account Codex từ backup JSON hoặc DB SQLite 9Router"
                        : "Nhập account Codex từ backup JSON 9Router; DB SQLite chỉ có trên app local"
                    }
                    onClick={() => importFile.current?.click()}
                  >
                    Import từ DB 9Router
                  </button>
                </div>
              </div>
              <div className="connect-grid">
                {["codex"].map((provider) => (
                  <div className="connect-card" key={provider}>
                    <div className="provider-icon">Cx</div>
                    <div className="grow">
                      <h3>{providerName(provider)}</h3>
                      <p>OAuth quota · scheduled inference</p>
                    </div>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => connect(provider)}
                    >
                      + Connect
                    </button>
                  </div>
                ))}
              </div>
              <div className="account-grid">
                {accounts.filter((a) => a.kind === "oauth").map(accountCard)}
              </div>
              {!accounts.some((a) => a.kind === "oauth") && (
                <div className="empty">
                  <span className="empty-mark">01</span>
                  <h3>Kết nối tài khoản đầu tiên</h3>
                  <p>
                    Đăng nhập OAuth để theo dõi quota thật của từng tài khoản.
                  </p>
                </div>
              )}
              <div className="section-heading custom-heading">
                <div>
                  <h2>Custom Providers</h2>
                  <p>
                    OpenAI-compatible hoặc Anthropic-compatible. API key được mã
                    hóa.
                  </p>
                </div>
                <button onClick={() => setCustom("new")}>
                  + Thêm provider
                </button>
              </div>
              <div className="account-grid">
                {accounts.filter((a) => a.kind === "custom").map(accountCard)}
              </div>
              {!accounts.some((a) => a.kind === "custom") && (
                <div className="empty compact">
                  <h3>Endpoint riêng, cùng một nơi quản lý.</h3>
                  <p>
                    Quota: Not available nếu provider không có API quota được hỗ
                    trợ.
                  </p>
                </div>
              )}
            </>
          )}
          {tab === "Quota Tracker" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Quota Tracker</h2>
                  <p>Hai cửa sổ độc lập. Mốc reset do provider cung cấp.</p>
                </div>
                <Badge>Cache 60s · stale sau 5 phút</Badge>
              </div>
              {!accounts.length && (
                <div className="empty">
                  <h3>Chưa có tài khoản</h3>
                  <p>Kết nối OAuth trong Accounts để xem quota.</p>
                  <button onClick={() => setTab("Accounts")}>
                    Mở Accounts
                  </button>
                </div>
              )}
              <div className="quota-grid">
                {accounts.map((a) => {
                  const q = quotas.find((q) => q.accountId === a.id);
                  return (
                    <article
                      className={`quota-card ${a.enabled ? "is-enabled" : ""}`}
                      key={a.id}
                    >
                      <div className="compact-card-head">
                        <div className="provider-icon">
                          {a.kind === "custom" ? "API" : "Cx"}
                        </div>
                        <div className="grow">
                          <h3>
                            {a.provider === "codex"
                              ? "OpenAI Codex"
                              : providerName(a.provider)}
                          </h3>
                          <span className="muted">{a.name}</span>
                        </div>
                        <div className="compact-actions quota-actions">
                          <IconButton
                            label="Refresh quota"
                            disabled={busy || !a.enabled || a.kind !== "oauth"}
                            onClick={() =>
                              action(
                                () =>
                                  api(`/quotas/${a.id}/refresh`, "POST", {}),
                                "Đã yêu cầu kiểm tra quota.",
                              )
                            }
                          >
                            ↻
                          </IconButton>
                          <IconButton
                            label="Account history"
                            onClick={() =>
                              setLogs({ title: a.name, accountId: a.id })
                            }
                          >
                            ◷
                          </IconButton>
                          <Switch
                            checked={a.enabled}
                            disabled={busy}
                            label={
                              a.enabled ? "Disable account" : "Enable account"
                            }
                            onChange={() =>
                              action(() =>
                                api(`/accounts/${a.id}`, "PATCH", {
                                  enabled: !a.enabled,
                                }),
                              )
                            }
                          />
                        </div>
                      </div>
                      {(() => {
                        const windows = (["window5h", "weekly"] as const)
                          .map((key) => [key, q?.[key]] as const)
                          .filter(
                            ([key, w]) =>
                              key !== "weekly" || w?.remaining != null,
                          );
                        return (
                          <>
                            <div className="quota-count">
                              {windows.length} quota
                              {windows.length === 1 ? "" : "s"}
                            </div>
                            {windows.map(([key, w], index) => {
                              const remaining =
                                w?.remaining !== null &&
                                w?.remaining !== undefined
                                  ? Math.round(w.remaining * 10) / 10
                                  : null;
                              return (
                                <div className="quota-line" key={key}>
                                  <div className="quota-name">
                                    <h4>{index === 0 ? "5h" : "Weekly"}</h4>
                                  </div>
                                  <div className="quota-track">
                                    <progress
                                      max="100"
                                      value={
                                        remaining === null ? 0 : remaining
                                      }
                                      aria-label={`${index === 0 ? "5-hour" : "Weekly"} quota remaining`}
                                      className={`${quotaTone(w || null)} ${remaining === null ? "unknown" : ""}`}
                                    />
                                    <span>
                                      {remaining === null
                                        ? "Unknown"
                                        : `${remaining} / 100`}
                                    </span>
                                  </div>
                                  <strong
                                    className={`quota-percent ${quotaTone(w || null)}`}
                                  >
                                    {remaining === null ? "—" : `${remaining}%`}
                                  </strong>
                                  <time className="quota-countdown">
                                    {w?.resetAt
                                      ? `in ${countdown(w.resetAt)}`
                                      : "Reset unknown"}
                                  </time>
                                </div>
                              );
                            })}
                            {q?.error && (
                              <div className="quota-meta">
                                <span className="error">
                                  {q.error} · dữ liệu cũ được giữ lại
                                </span>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </article>
                  );
                })}
              </div>
              <p className="footnote">
                Quota không được cộng gộp. Inference thành công không bảo đảm
                bắt đầu cửa sổ quota mới.
              </p>
            </>
          )}
          {tab === "Scheduler" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Scheduler</h2>
                  <p>
                    Một lịch, một tài khoản. Mỗi occurrence gửi tối đa một
                    request.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => setEditSchedule("new")}
                  disabled={
                    !accounts.some(
                      (a) =>
                        a.kind === "oauth" && a.schedulerSupported && a.enabled,
                    )
                  }
                >
                  + Tạo lịch
                </button>
              </div>
              <div className="info-box">
                <strong>Lịch hoạt động khi đóng trình duyệt.</strong>
                <span>
                  Inference có thể tiêu thụ quota. Không bảo đảm reset. Lịch trễ
                  quá 5 phút được đánh dấu missed.
                </span>
              </div>
              {!schedules.length ? (
                <div className="empty">
                  <span className="empty-mark">07:00</span>
                  <h3>Bắt đầu ngày mới, theo lịch của sư tổ.</h3>
                  <p>
                    Chọn tài khoản OAuth, model và múi giờ. Server xử lý phần
                    còn lại.
                  </p>
                  {!accounts.some((a) => a.schedulerSupported) && (
                    <button onClick={() => setTab("Accounts")}>
                      Kết nối tài khoản được hỗ trợ
                    </button>
                  )}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Lịch / tài khoản</th>
                        <th>Model</th>
                        <th>Giờ địa phương</th>
                        <th>Chạy tiếp theo</th>
                        <th>Trạng thái</th>
                        <th>Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedules.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <strong>{s.name}</strong>
                            <small>
                              {accounts.find((a) => a.id === s.accountId)
                                ?.name || "Tài khoản không tồn tại"}
                            </small>
                          </td>
                          <td>
                            <code>{s.model}</code>
                            <small>
                              {s.skipIfActive
                                ? "Skip khi xác minh cửa sổ 5h đang active"
                                : "Preset: " + s.preset}
                            </small>
                          </td>
                          <td>
                            <strong>{s.localTime}</strong>
                            <small>{s.timezone}</small>
                            <small>
                              {s.weekdays.length === 7
                                ? "Hằng ngày"
                                : s.weekdays.map((d) => days[d]).join(", ")}
                            </small>
                          </td>
                          <td>
                            {s.enabled
                              ? format(s.nextRunAtUtc, s.timezone)
                              : "Đã tắt"}
                            <small>{s.timezone}</small>
                          </td>
                          <td>
                            <Badge status={s.last_status || ""}>
                              {s.last_status || "Chưa chạy"}
                            </Badge>
                            <small>{s.enabled ? "Enabled" : "Disabled"}</small>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button onClick={() => setEditSchedule(s)}>
                                Sửa
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  action(() =>
                                    api(`/schedules/${s.id}`, "PATCH", {
                                      enabled: !s.enabled,
                                    }),
                                  )
                                }
                              >
                                {s.enabled ? "Disable" : "Enable"}
                              </button>
                              <button
                                disabled={
                                  busy ||
                                  executions.some(
                                    (e) =>
                                      e.schedule_id === s.id &&
                                      e.status === "running",
                                  )
                                }
                                onClick={() => {
                                  if (
                                    confirm(
                                      `Run test now: gửi một inference thật qua ${s.model}. Thao tác này có thể tiêu thụ quota, không bảo đảm reset. Tiếp tục?`,
                                    )
                                  ) {
                                    const key = crypto.randomUUID();
                                    action(
                                      () =>
                                        api(
                                          `/schedules/${s.id}/run-now`,
                                          "POST",
                                          { acknowledgeQuota: true },
                                          { "Idempotency-Key": key },
                                        ),
                                      "Đã nhận lệnh chạy. Xem execution logs để biết kết quả.",
                                    );
                                  }
                                }}
                              >
                                Run test now
                              </button>
                              <button
                                onClick={() =>
                                  setLogs({ title: s.name, scheduleId: s.id })
                                }
                              >
                                View logs
                              </button>
                              <button
                                className="danger-link"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    confirm(
                                      `Xóa lịch ${s.name}? Lịch sử được giữ lại.`,
                                    )
                                  )
                                    action(() =>
                                      api(`/schedules/${s.id}`, "DELETE"),
                                    );
                                }}
                              >
                                Xóa
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="section-heading">
                <div>
                  <h2>Execution history</h2>
                  <p>
                    {executions.length} bản ghi gần nhất · không lưu prompt,
                    response hoặc credentials.
                  </p>
                </div>
                <button onClick={() => setLogs({ title: "Execution history" })}>
                  Mở logs
                </button>
              </div>
              <History items={executions.slice(0, 5)} format={format} />
            </>
          )}
        </section>
        <footer>
          <span>
            QUOTA PILOT <span className="muted">/ standalone</span>
          </span>
          <span>Workers · D1 · Cron Triggers</span>
        </footer>
      </main>
      {custom && (
        <CustomForm
          current={custom === "new" ? null : custom}
          busy={busy}
          close={() => setCustom(null)}
          save={(body) =>
            action(async () => {
              await api(
                custom === "new" ? "/accounts" : `/accounts/${custom.id}`,
                custom === "new" ? "POST" : "PATCH",
                body,
              );
              setCustom(null);
            })
          }
          error={error}
        />
      )}
      {editSchedule && (
        <ScheduleForm
          current={editSchedule === "new" ? null : editSchedule}
          accounts={accounts}
          busy={busy}
          close={() => setEditSchedule(null)}
          save={(body) =>
            action(async () => {
              await api(
                editSchedule === "new"
                  ? "/schedules"
                  : `/schedules/${editSchedule.id}`,
                editSchedule === "new" ? "POST" : "PATCH",
                body,
              );
              setEditSchedule(null);
            })
          }
          error={error}
        />
      )}
      {oauth && (
        <Modal
          title={`Kết nối ${providerName(oauth.provider)}`}
          close={closeOAuth}
        >
          <div className="form-body">
            <p>
              Đang chờ đăng nhập trong cửa sổ OAuth. Tài khoản sẽ được cập nhật
              tự động.
            </p>
            <button
              className="button primary"
              onClick={() => {
                oauthPopup.current = window.open(
                  oauth.authUrl,
                  "quota-pilot-oauth",
                  "popup=yes,width=560,height=760",
                );
              }}
            >
              Mở lại cửa sổ đăng nhập
            </button>
            <details>
              <summary>
                Hoàn tất thủ công khi dùng trình duyệt trên máy khác
              </summary>
              <div className="info-box">
                <span>
                  Redirect URI:{" "}
                  <code className="break">{oauth.redirectUri}</code>
                </span>
                <span>
                  Provider phải chấp nhận URI này. Nếu từ chối, cần OAuth
                  client/redirect URI đã đăng ký.
                </span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  action(async () => {
                    await api(`/oauth/${oauth.provider}/complete`, "POST", {
                      state: oauth.state,
                      code: callback,
                    });
                    closeOAuth();
                  }, "Đã kết nối OAuth.");
                }}
              >
                <label>
                  URL callback hoặc code
                  <input
                    value={callback}
                    onChange={(e) => setCallback(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                <div className="form-actions">
                  <button type="button" onClick={() => action(reload)}>
                    Đã callback · cập nhật danh sách
                  </button>
                  <button className="primary" disabled={busy}>
                    Hoàn tất kết nối
                  </button>
                </div>
              </form>
            </details>
          </div>
        </Modal>
      )}
      {logs && (
        <Modal title={logs.title} close={() => setLogs(null)} wide>
          <div className="form-body">
            <History
              items={executions.filter(
                (e) =>
                  (!logs.scheduleId || e.schedule_id === logs.scheduleId) &&
                  (!logs.accountId || e.account_id === logs.accountId),
              )}
              format={format}
              detail
            />
            <button disabled={busy} onClick={() => action(reload)}>
              Cập nhật logs
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function CustomForm({
  current,
  close,
  save,
  busy,
  error,
}: {
  current: Account | null;
  close: () => void;
  save: (body: unknown) => void;
  busy: boolean;
  error: string;
}) {
  const [name, setName] = useState(current?.name || ""),
    [provider, setProvider] = useState(
      current?.provider || "openai-compatible",
    ),
    [baseUrl, setBaseUrl] = useState(current?.config.baseUrl || ""),
    [key, setKey] = useState(""),
    [models, setModels] = useState(current?.config.models?.join(", ") || ""),
    [headers, setHeaders] = useState("");
  const [localError, setLocalError] = useState("");
  return (
    <Modal
      title={current ? "Sửa custom provider" : "Thêm custom provider"}
      close={close}
    >
      <form
        className="form-body"
        onSubmit={(event) => {
          event.preventDefault();
          let parsed;
          try {
            parsed = headers.trim() ? JSON.parse(headers) : undefined;
          } catch {
            setLocalError("Headers phải là JSON object.");
            return;
          }
          setLocalError("");
          save({
            name,
            provider,
            baseUrl,
            ...(key ? { apiKey: key } : {}),
            models: models
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            ...(parsed === undefined ? {} : { headers: parsed }),
          });
        }}
      >
        <label>
          Tên hiển thị
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Loại provider
          <select
            value={provider}
            disabled={!!current}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic-compatible">Anthropic-compatible</option>
          </select>
        </label>
        <label>
          Base URL (gồm /v1 nếu provider yêu cầu)
          <input
            type="url"
            required
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <small>
          Host phải có trong CUSTOM_PROVIDER_HOSTS của server. Chỉ HTTPS public,
          không theo redirect.
        </small>
        <label>
          API key {current && "(để trống để giữ nguyên)"}
          <input
            type="password"
            required={!current}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label>
          Model IDs, phân cách bằng dấu phẩy
          <input
            required
            value={models}
            placeholder="model-id-1, model-id-2"
            onChange={(e) => setModels(e.target.value)}
          />
        </label>
        <label>
          Headers tùy chọn (JSON; để trống để giữ nguyên)
          <textarea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            placeholder={'{"X-Project": "project-id"}'}
            rows={3}
            autoComplete="off"
          />
        </label>
        {current?.config.headerNames?.length ? (
          <small>
            Headers đã lưu: {current.config.headerNames.join(", ")}. Nhập {"{}"}{" "}
            để xóa.
          </small>
        ) : null}
        <p className="footnote">Test gọi GET /models; không gửi inference.</p>
        {(localError || error) && (
          <p className="error" role="alert">
            {localError || error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={close}>
            Hủy
          </button>
          <button className="primary" disabled={busy}>
            Lưu provider
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ScheduleForm({
  current,
  accounts,
  close,
  save,
  busy,
  error,
}: {
  current: Schedule | null;
  accounts: Account[];
  close: () => void;
  save: (body: unknown) => void;
  busy: boolean;
  error: string;
}) {
  const options = accounts.filter(
    (a) =>
      a.kind === "oauth" &&
      ((a.schedulerSupported && a.enabled) || a.id === current?.accountId),
  );
  const [name, setName] = useState(current?.name || "Morning check"),
    [accountId, setAccountId] = useState(
      current?.accountId || options[0]?.id || "",
    ),
    [model, setModel] = useState(current?.model || options[0]?.models[0] || ""),
    [localTime, setLocalTime] = useState(current?.localTime || "07:00"),
    [timezone, setTimezone] = useState(current?.timezone || "Asia/Ho_Chi_Minh"),
    [weekdays, setWeekdays] = useState(
      current?.weekdays || [0, 1, 2, 3, 4, 5, 6],
    ),
    [enabled, setEnabled] = useState(current?.enabled ?? true),
    [skipIfActive, setSkip] = useState(current?.skipIfActive || false),
    [preset, setPreset] = useState(current?.preset || "ping");
  return (
    <Modal title={current ? "Sửa lịch" : "Tạo lịch"} close={close}>
      <form
        className="form-body"
        onSubmit={(event) => {
          event.preventDefault();
          save({
            name,
            accountId,
            model,
            localTime,
            timezone,
            weekdays,
            enabled,
            skipIfActive,
            preset,
          });
        }}
      >
        <label>
          Tên lịch
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Tài khoản OAuth
          <select
            required
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setModel(
                accounts.find((a) => a.id === e.target.value)?.models[0] || "",
              );
            }}
          >
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {providerName(a.provider)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {accounts
              .find((a) => a.id === accountId)
              ?.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
          </select>
        </label>
        <small>
          Danh sách từ registry 9Router local. Provider quyết định model có khả
          dụng với gói tài khoản khi thực thi.
        </small>
        <div className="form-grid">
          <label>
            Giờ địa phương
            <input
              type="time"
              required
              value={localTime}
              onChange={(e) => setLocalTime(e.target.value)}
            />
          </label>
          <label>
            Múi giờ
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </label>
        </div>
        <fieldset>
          <legend>Ngày chạy</legend>
          <div className="weekdays">
            {days.map((day, index) => (
              <label
                key={day}
                className={weekdays.includes(index) ? "checked" : ""}
              >
                <input
                  type="checkbox"
                  checked={weekdays.includes(index)}
                  onChange={(e) =>
                    setWeekdays(
                      e.target.checked
                        ? [...weekdays, index]
                        : weekdays.filter((d) => d !== index),
                    )
                  }
                />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Nội dung tối thiểu
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="ping">Reply only OK.</option>
            <option value="hello">Say hello in one word.</option>
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={skipIfActive}
            onChange={(e) => setSkip(e.target.checked)}
          />
          Skip if active 5h window khi quota mới xác minh được
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Bật lịch
        </label>
        <div className="info-box">
          <span>
            Mỗi occurrence gửi tối đa một inference thật, có thể tiêu thụ quota.
            Không bảo đảm reset cửa sổ quota.
          </span>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={close}>
            Hủy
          </button>
          <button
            className="primary"
            disabled={busy || !weekdays.length || !accountId}
          >
            Lưu lịch
          </button>
        </div>
      </form>
    </Modal>
  );
}
function History({
  items,
  format,
  detail = false,
}: {
  items: Execution[];
  format: (value: string | null) => string;
  detail?: boolean;
}) {
  if (!items.length)
    return (
      <div className="empty compact">
        <p>Chưa có execution. Không có request nào được gửi.</p>
      </div>
    );
  return (
    <div className="history">
      {items.map((e) => (
        <article key={e.id}>
          <div className="history-line">
            <Badge status={e.status}>{e.status}</Badge>
            <strong>{e.schedule_name}</strong>
            <code>{e.model}</code>
            <time>{format(e.occurrence_at)}</time>
          </div>
          {e.error_code && (
            <p className="error">
              {e.error_code}
              {e.http_status ? ` · HTTP ${e.http_status}` : ""}
            </p>
          )}
          {detail && (
            <>
              <div className="history-times">
                <span>Started: {format(e.started_at)}</span>
                <span>Finished: {format(e.finished_at)}</span>
                <code>ID: {e.id}</code>
              </div>
              <details>
                <summary>Quota trước / sau</summary>
                <pre>
                  {JSON.stringify(
                    {
                      before: e.quota_before
                        ? JSON.parse(e.quota_before)
                        : null,
                      after: e.quota_after ? JSON.parse(e.quota_after) : null,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </article>
      ))}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
