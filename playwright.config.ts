import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

process.env.ARCHIPEL_E2E_DATABASE ||= join(
  mkdtempSync(join(tmpdir(), "archipel-browser-")),
  "db.sqlite",
);
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  use: {
    baseURL: "http://127.0.0.1:8790",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:8790/health",
      reuseExistingServer: false,
      env: {
        PORT: "8790",
        // A suite shares these throwaway instances and exercises many accounts at once.
        RATE_LIMIT_API: "3000",
        RATE_LIMIT_AUTH: "300",
        HOST: "127.0.0.1",
        BASE_URL: "http://127.0.0.1:8790",
        XMPP_DOMAIN: "chat.example",
        XMPP_BRIDGE_SECRET: "browser-test-bridge-secret-with-43-characters-minimum",
        DATABASE_PATH: process.env.ARCHIPEL_E2E_DATABASE,
        OIDC_ISSUER: "",
        OIDC_CLIENT_ID: "",
      },
    },
    {
      command: "node --import tsx src/server.ts",
      url: "http://127.0.0.1:8791/health",
      reuseExistingServer: false,
      env: {
        PORT: "8791",
        RATE_LIMIT_API: "3000",
        RATE_LIMIT_AUTH: "300",
        DEV_AUTH: "true",
        HOST: "127.0.0.1",
        BASE_URL: "http://127.0.0.1:8791",
        DATABASE_PATH: join(
          dirname(process.env.ARCHIPEL_E2E_DATABASE!),
          "peer.sqlite",
        ),
        OIDC_ISSUER: "",
        OIDC_CLIENT_ID: "",
      },
    },
  ],
  reporter: [["list"], ["./e2e/teardown.ts"]],
});
