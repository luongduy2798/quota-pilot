import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const path = ".dev.vars";
if (existsSync(path)) {
  console.error(".dev.vars exists. Preserve it; edit settings manually.");
  process.exit(1);
}
const readline = createInterface({ input: stdin, output: stdout });
try {
  const password = await readline.question(
    "Choose admin password (16+ characters): ",
  );
  if (password.length < 16 || password.length > 500 || !/\S/.test(password))
    throw Error("Password must be 16–500 characters.");
  const salt = randomBytes(16),
    hash = pbkdf2Sync(password, salt, 310000, 32, "sha256");
  const key = randomBytes(32).toString("base64"),
    session = randomBytes(32).toString("base64");
  const vars =
    [
      `APP_ORIGIN=http://127.0.0.1:8788`,
      `ADMIN_PASSWORD_HASH=310000:${salt.toString("base64")}:${hash.toString("base64")}`,
      `ENCRYPTION_KEY=${key}`,
      `SESSION_SECRET=${session}`,
      "DEFAULT_TIMEZONE=Asia/Ho_Chi_Minh",
      "CUSTOM_PROVIDER_HOSTS=api.openai.com,api.anthropic.com",
      "CLAUDE_SCHEDULER_ENABLED=false",
      "CODEX_REDIRECT_URI=http://localhost:1455/auth/callback",
      "CLAUDE_REDIRECT_URI=",
      "CODEX_CLIENT_ID=",
      "CLAUDE_CLIENT_ID=",
      "UPSTREAM_PROXY_URL=http://127.0.0.1:8789/fetch",
    ].join("\n") + "\n";
  writeFileSync(path, vars, { mode: 0o600, flag: "wx" });
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 8);
  console.log(
    `Created ${path} (0600). Encryption key fingerprint: ${digest}. Back up .dev.vars securely; losing it makes stored credentials unrecoverable.`,
  );
} finally {
  readline.close();
}
