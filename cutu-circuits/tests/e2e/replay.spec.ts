import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { assemblyStages } from "../../apps/web/src/assemblyReveal";

async function trigger(
  page: Page,
  projectId: string,
  action: "start" | "stop" = "start",
) {
  await page.evaluate(
    ({ projectId, action }) => {
      window.dispatchEvent(
        new CustomEvent("cutu:build-makada", { detail: { projectId, action } }),
      );
    },
    { projectId, action },
  );
}

async function openMakada(page: Page, request: APIRequestContext) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await request.post("/api/projects", {
    data: { name: `Build Makada fixture ${Date.now()}`, template: "spidey" },
  });
  expect(response.ok()).toBeTruthy();
  const project = await response.json();
  await page.addInitScript(
    (id) => localStorage.setItem("cutucircuits:active-project", id),
    project.id,
  );
  await page.goto("/");
  await expect(page.locator(".canvas-area")).toHaveAttribute(
    "data-build-ready",
    "true",
    { timeout: 60000 },
  );
  return project;
}

test("tool-triggered Makada build reveals each leg and finishes still, without recompiling", async ({
  page,
  request,
}) => {
  let compiles = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/compile$/.test(request.url()))
      compiles++;
  });
  const project = await openMakada(page, request);
  await expect(
    page.getByRole("button", { name: "Replay assembly", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toHaveCount(0);
  const before = compiles;
  await page.clock.install();
  const started = await request.post(
    `/api/projects/${project.id}/presentation/build`,
    {
      data: { action: "start" },
    },
  );
  expect(started.ok()).toBeTruthy();
  expect(await started.json()).toMatchObject({
    status: "started",
    hardwareCommandsSent: false,
  });
  const show = page.getByRole("region", {
    name: "Building Makada",
    exact: true,
  });
  const scene = page.locator(".scene");
  await expect(show).toHaveAttribute("data-stage", "0");
  await page.clock.runFor(32);
  let previous = Number(await scene.getAttribute("data-visible-entity-count"));
  for (let stage = 1; stage < assemblyStages.length; stage++) {
    await page.clock.runFor(assemblyStages[stage - 1].durationMs + 32);
    await expect(show).toHaveAttribute("data-stage", String(stage));
    await expect(scene).toHaveAttribute(
      "data-assembly-replay-stage",
      String(stage),
    );
    const visible = Number(
      await scene.getAttribute("data-visible-entity-count"),
    );
    if (stage <= 9) expect(visible).toBeGreaterThan(previous);
    if (stage >= 2 && stage <= 7) expect(visible - previous).toBe(2);
    previous = visible;
  }
  expect(previous).toBe(81);
  await page.clock.runFor(assemblyStages.at(-1)!.durationMs + 32);
  await expect(show).toHaveCount(0);
  await expect(scene).toHaveAttribute("data-assembly-replay-stage", "complete");
  await expect(scene).toHaveAttribute("data-preview-distance-mm", "0");
  await page.clock.runFor(5000);
  await expect(scene).toHaveAttribute("data-preview-distance-mm", "0");
  expect(compiles).toBe(before);
});

test("hidden build pauses its clock, stop restores all parts, and leaving assembly cancels", async ({
  page,
  request,
}) => {
  const project = await openMakada(page, request);
  await page.clock.install();
  const show = page.getByRole("region", {
    name: "Building Makada",
    exact: true,
  });
  await trigger(page, project.id);
  await expect(show).toHaveAttribute("data-stage", "0");
  await page.clock.runFor(1000);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(12000);
  await expect(show).toHaveAttribute("data-stage", "0");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(3100);
  await expect(show).toHaveAttribute("data-stage", "1");
  await show
    .getByRole("button", { name: "Stop building", exact: true })
    .click();
  await page.clock.runFor(32);
  await expect(show).toHaveCount(0);
  await expect(page.locator(".scene")).toHaveAttribute(
    "data-visible-entity-count",
    "81",
  );
  await trigger(page, project.id);
  await expect(show).toHaveAttribute("data-stage", "0");
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
  await page.clock.runFor(10000);
  await expect(show).toHaveCount(0);
  await page.getByRole("tab", { name: "Assembly", exact: true }).click();
  await page.clock.runFor(32);
  await expect(page.locator(".scene")).toHaveAttribute(
    "data-assembly-replay-stage",
    "complete",
  );
  await expect(
    page.getByRole("button", { name: "Replay assembly", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toHaveCount(0);
});

