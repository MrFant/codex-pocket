import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 25_000,
  use: {
    ...devices["iPhone 13"],
    baseURL: "http://127.0.0.1:3219",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium", channel: process.env.POCKET_TEST_BROWSER_CHANNEL || "chrome" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "node test/fixtures/browser-server.mjs",
    url: "http://127.0.0.1:3219/api/status",
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
