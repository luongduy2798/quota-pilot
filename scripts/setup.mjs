import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const path = ".env";
if (existsSync(path)) {
  console.error(".env exists. Preserve it; edit settings manually.");
  process.exit(1);
}
const readline = createInterface({ input: stdin, output: stdout });
try {
  const password = await readline.question("Choose admin password: ");
  if (password.length < 1 || password.length > 500)
    throw Error("Password must be 1–500 characters.");
  const salt = randomBytes(16);
  let hash = createHmac("sha256", password).update(salt).digest();
  for (let count = 1; count < 1000; count++)
    hash = createHmac("sha256", password).update(hash).digest();
  const encoded = (value) =>
    value
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const key = randomBytes(32).toString("base64"),
    session = randomBytes(32).toString("base64");
  const vars =
    [
      `APP_ORIGIN=${process.env.APP_ORIGIN || "http://127.0.0.1:8788"}`,
      `ADMIN_PASSWORD_HASH=hmac1:${encoded(salt)}:${encoded(hash)}`,
      `ENCRYPTION_KEY=${key}`,
      `SESSION_SECRET=${session}`,
      "DEFAULT_TIMEZONE=Asia/Ho_Chi_Minh",
      "CUSTOM_PROVIDER_HOSTS=api.openai.com,api.anthropic.com",
      `CODEX_REDIRECT_URI=${process.env.CODEX_REDIRECT_URI || "http://localhost:1455/auth/callback"}`,
      "CODEX_CLIENT_ID=",
      "PORT=8788",
      "DB_PATH=./data/quota-pilot.sqlite",
      ...(process.env.COMPOSE_PROFILES === "tunnel" ? ["COMPOSE_PROFILES=tunnel"] : []),
      `QUOTA_PILOT_UID=${process.getuid?.() ?? 1000}`,
      `QUOTA_PILOT_GID=${process.getgid?.() ?? 1000}`,
    ].join("\n") + "\n";
  writeFileSync(path, vars, { mode: 0o600, flag: "wx" });
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 8);
  console.log(
    `Created ${path} (0600). Encryption key fingerprint: ${digest}. Back up .env securely; losing it makes stored credentials unrecoverable.`,
  );
} finally {
  readline.close();
}
