import { defineConfig, devices } from "@playwright/test";

const off = "http://127.0.0.1:8787";
const on = "http://127.0.0.1:8788";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: [["list"]],
  use: {
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: [
    {
      command: "node test/mock-x/server.mjs",
      url: "http://127.0.0.1:9099/cdn-cgi/access/certs",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "sh scripts/dev-proof.sh",
      env: { ...process.env, PORT: "8787", PERSIST: ".wrangler/proof-off" },
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "sh scripts/dev-proof.sh --var POSTING_ENABLED:true",
      env: { ...process.env, PORT: "8788", PERSIST: ".wrangler/proof-on" },
      url: "http://127.0.0.1:8788/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "off",
      testMatch: /off\.spec\.ts|proof\.spec\.ts|zz-dialogs\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: off },
    },
    {
      name: "iphone",
      testMatch: /iphone\.spec\.ts/,
      use: { ...devices["iPhone 13"], baseURL: off },
    },
    {
      name: "flow",
      testMatch: /flow\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: on, video: "on", viewport: { width: 1440, height: 900 } },
    },
  ],
});
