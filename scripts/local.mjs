import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { startOAuthListener } from "./oauth-listener.mjs";
import { startUpstreamBridge } from "./upstream-bridge.mjs";

if (!existsSync(".dev.vars")) {
  console.error("Run npm run setup first.");
  process.exit(1);
}
const values = Object.fromEntries(
  readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
let callback;
let bridge;
try {
  callback = await startOAuthListener(values.APP_ORIGIN);
  bridge = await startUpstreamBridge();
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? "OAuth callback port 1455 is busy. Close the other OAuth login, then restart yarn dev."
      : "Cannot start local OAuth callback listener.",
  );
  process.exit(1);
}
const local = spawn(
  platform() === "win32" ? "npx.cmd" : "npx",
  ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", "8788"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...values,
    },
  },
);
const cron = setInterval(() => {
  void fetch("http://127.0.0.1:8788/cdn-cgi/local/scheduled").catch(() => {});
}, 60000);
try {
  await once(local, "exit");
} finally {
  clearInterval(cron);
  callback.close();
  bridge?.close();
}
