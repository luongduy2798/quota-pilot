import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);
const base = process.env.QUOTA_PILOT_URL || "http://localhost:8788";
const db =
  process.env.NINEROUTER_DB || `${process.env.HOME}/.9router/db/data.sqlite`;
const password = (await readFile(".local-admin-password", "utf8")).trim();
const { stdout } = await run("sqlite3", [
  "-json",
  db,
  "select name,email,data from providerConnections where provider='codex' and authType='oauth'",
]);
const accounts = JSON.parse(stdout).map((row) => ({
  name: row.name || row.email || "Codex account",
  data: JSON.parse(row.data),
}));
const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw Error(`Quota Pilot login failed (${login.status})`);
const { csrf } = await login.json();
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
let imported = 0;
for (const account of accounts) {
  const response = await fetch(`${base}/api/accounts/import-9router`, {
    method: "POST",
    headers: {
      Origin: base,
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accounts: [account] }),
  });
  if (!response.ok)
    throw Error(
      `Import failed for ${account.name} (${response.status}): ${await response.text()}`,
    );
  imported += (await response.json()).imported.length;
}
console.log(`Imported ${imported} Codex accounts from 9Router.`);
