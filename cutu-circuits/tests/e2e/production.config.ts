import { defineConfig } from "@playwright/test";
import path from "node:path";
import shared, { runtimeServer } from "../../playwright.config";
const port = Number(process.env.CUTUCIRCUITS_TEST_PORT ?? 4310);

/** Verify the built UI and runtime together, without development HMR. */
export default defineConfig({
  ...shared,
  testDir: path.resolve("tests/e2e"),
  outputDir: path.resolve("artifacts/e2e-production"),
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.resolve("artifacts/e2e-production-report"),
        open: "never",
      },
    ],
  ],
  use: { ...shared.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: [{ ...runtimeServer, command: "npm start", url: `http://127.0.0.1:${port}/api/health`, env: { ...runtimeServer.env, PORT: String(port) } }],
});
