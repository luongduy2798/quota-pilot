import { startOAuthListener } from "./oauth-listener.mjs";

const target = process.env.OAUTH_TARGET_ORIGIN || process.argv[2];
if (!target) {
  console.error(
    "Set OAUTH_TARGET_ORIGIN or pass the dashboard origin, e.g. https://quota.chillix.me.",
  );
  process.exit(1);
}

try {
  const listener = await startOAuthListener(target, 1455, true);
  console.log(
    `OAuth callback relay listening on http://localhost:1455 → ${new URL(target).origin}`,
  );
  const close = () => listener.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    console.error(
      "Port 1455 đang được process khác dùng. Dừng npm run dev hoặc 9Router đang chạy, rồi chạy lại relay.",
    );
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
