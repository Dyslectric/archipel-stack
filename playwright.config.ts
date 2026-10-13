import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const port = Number(process.env.ARCHIPEL_E2E_PORT || 8790);
process.env.ARCHIPEL_E2E_DATABASE ||= join(
  mkdtempSync(join(tmpdir(), "archipel-browser-")),
  "db.sqlite",
);
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/browser",
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm run dev",
      url: `http://127.0.0.1:${port}/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(port),
        // A suite shares these throwaway instances and exercises many accounts at once.
        RATE_LIMIT_API: "3000",
        RATE_LIMIT_AUTH: "300",
        HOST: "127.0.0.1",
        BASE_URL: `http://127.0.0.1:${port}`,
        XMPP_DOMAIN: "chat.example",
        XMPP_BRIDGE_SECRET: "browser-test-bridge-secret-with-43-characters-minimum",
        DATABASE_PATH: process.env.ARCHIPEL_E2E_DATABASE,
        OIDC_ISSUER: "",
        OIDC_CLIENT_ID: "",
      },
    },
    {
      command: "node --import tsx src/server.ts",
      url: `http://127.0.0.1:${port + 1}/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(port + 1),
        RATE_LIMIT_API: "3000",
        RATE_LIMIT_AUTH: "300",
        DEV_AUTH: "true",
        HOST: "127.0.0.1",
        BASE_URL: `http://127.0.0.1:${port + 1}`,
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
