import { defineConfig } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Each run owns fresh local data, outside a potentially synced source checkout.
// Reusing a demo runtime would mix QA projects with the user's engineering work.
export const runtimeServer = {
  command: "npm run dev -w @cutucircuits/runtime",
  url: "http://127.0.0.1:4310/api/health",
  reuseExistingServer: false,
  timeout: 120_000,
  env: {
    CUTUCIRCUITS_DATA_DIR: mkdtempSync(
      path.join(tmpdir(), "cutucircuits-e2e-"),
    ),
  },
};

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  outputDir: "artifacts/e2e",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : existsSync("/usr/bin/chromium")
          ? { executablePath: "/usr/bin/chromium" }
          : {}),
      args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: [
    runtimeServer,
    {
      command: "npm run dev -w @cutucircuits/web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
