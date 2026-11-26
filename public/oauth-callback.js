const messageBox = document.querySelector('[role="status"]');
const params = new URLSearchParams(window.location.search);
const states = params.getAll("state");
const codes = params.getAll("code");
const state = states[0];
const validState = states.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(state);
history.replaceState(null, "", window.location.pathname);

function showResult(message, error = null) {
  messageBox.textContent = message;
  if (validState && window.opener)
    window.opener.postMessage({ type: "quota-pilot-oauth", state, error }, window.location.origin);
  if (error === null && window.opener) window.close();
}

async function completeOAuth() {
  if (!validState || (!params.has("error") && (codes.length !== 1 || !codes[0]))) {
    showResult("Callback không hợp lệ. Hãy bắt đầu lại từ dashboard.", "Callback không hợp lệ.");
    return;
  }
  if (params.has("error")) {
    showResult("Đăng nhập đã bị từ chối hoặc hủy.", "Đăng nhập đã bị từ chối hoặc hủy.");
    return;
  }
  try {
    const session = await fetch("/api/session");
    if (session.status === 401) {
      const message = "Phiên Quota Pilot đã hết hạn. Hãy đăng nhập và thử lại.";
      showResult(message, message);
      return;
    }
    const { csrf } = await session.json();
    if (!session.ok || typeof csrf !== "string") throw new Error("Session unavailable");
    const response = await fetch("/api/oauth/codex/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ state, code: codes[0] }),
    });
    const result = await response.json();
    if (!response.ok) {
      const message = typeof result.error === "string"
        ? `Chưa hoàn tất đăng nhập (${result.error}).`
        : "Chưa hoàn tất đăng nhập. Hãy thử lại.";
      showResult(message, message);
      return;
    }
    if (typeof result.accountId !== "string") throw new Error("OAuth completion unconfirmed");
    showResult("Đã kết nối tài khoản. Quay lại dashboard để xem kết quả.");
  } catch {
    const message = "Chưa xác nhận được kết quả. Kiểm tra danh sách tài khoản trên dashboard.";
    showResult(message, message);
  }
}

void completeOAuth();
