import { chromium, expect as baseExpect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const expect = baseExpect.configure({ timeout: 30_000 });
const base = process.env.CUTUCIRCUITS_URL ?? "http://127.0.0.1:5173";
const api = process.env.CUTUCIRCUITS_API ?? "http://127.0.0.1:4310/api";
const output = path.resolve("artifacts/overhaul");
await mkdir(output, { recursive: true });
const projects = await (await fetch(`${api}/projects`)).json();
const project = projects.find((item) => item.name === "Makada");
if (!project) throw new Error("The real Makada project is required");
await fetch(`${api}/projects/${project.id}/selection`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ entityId: null, origin: "workspace" }),
});
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const entries = [],
  errors = [],
  renderMeasurements = {};
const context = await browser.newContext({
  viewport: { width: 1512, height: 982 },
  reducedMotion: "reduce",
});
await context.addInitScript(() => {
  const requestFrame = window.requestAnimationFrame.bind(window);
  window.__cutuRafCallbacks = 0;
  window.requestAnimationFrame = (callback) =>
    requestFrame((time) => {
      window.__cutuRafCallbacks++;
      callback(time);
    });
});
await context.addInitScript(
  (id) => localStorage.setItem("cutucircuits:active-project", id),
  project.id,
);
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.on("pageerror", (error) => errors.push(error.message));
async function capture(name, caption, evidence) {
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: name !== "03-project-menu",
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  entries.push({
    name,
    caption,
    evidence,
    viewport: page.viewportSize(),
    overflow,
  });
  console.log(`Captured ${name}${overflow ? " [OVERFLOW]" : ""}`);
}
async function choose(label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
try {
  const assemblyCompilation = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${project.id}/compile`) &&
      response.request().method() === "POST",
    { timeout: 150_000 },
  );
  await page.goto(base);
  const compiledAssembly = await (await assemblyCompilation).json();
  expect(compiledAssembly.kind).toBe("cad");
  expect(compiledAssembly.shapes.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Loading native CAD geometry…", { exact: true }),
  ).toBeHidden({ timeout: 150_000 });
  await expect(page.locator(".cad-status")).toBeHidden();
  await page.waitForTimeout(500);
  let rafBefore = await page.evaluate(() => window.__cutuRafCallbacks);
  await page.waitForTimeout(1000);
  renderMeasurements.idleCallbacksPerSecond = await page.evaluate(
    (before) => window.__cutuRafCallbacks - before,
    rafBefore,
  );
  const assemblyCanvas = page.locator(".canvas-area canvas").first();
  const restingCanvas = await assemblyCanvas.screenshot();
  const canvasBounds = await assemblyCanvas.boundingBox();
  if (!canvasBounds) throw new Error("Assembly canvas is absent");
  rafBefore = await page.evaluate(() => window.__cutuRafCallbacks);
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width * 0.45,
    canvasBounds.y + canvasBounds.height * 0.55,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width * 0.55,
    canvasBounds.y + canvasBounds.height * 0.6,
    { steps: 8 },
  );
  await page.mouse.up();
  renderMeasurements.orbitCallbacks = await page.evaluate(
    (before) => window.__cutuRafCallbacks - before,
    rafBefore,
  );
  renderMeasurements.orbitChangesPixels = !restingCanvas.equals(
    await assemblyCanvas.screenshot(),
  );
  await page
    .getByRole("button", { name: "Fit assembly (F)", exact: true })
    .click();
  const fittedCanvas = await assemblyCanvas.screenshot();
  await page
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  rafBefore = await page.evaluate(() => window.__cutuRafCallbacks);
  await page.waitForTimeout(1000);
  renderMeasurements.playCallbacksPerSecond = await page.evaluate(
    (before) => window.__cutuRafCallbacks - before,
    rafBefore,
  );
  renderMeasurements.gaitChangesPixels = !fittedCanvas.equals(
    await assemblyCanvas.screenshot(),
  );
  await page
    .getByRole("button", { name: "Pause motion preview", exact: true })
    .click();
  await page.waitForTimeout(500);
  rafBefore = await page.evaluate(() => window.__cutuRafCallbacks);
  await page.waitForTimeout(1000);
  renderMeasurements.pausedCallbacksPerSecond = await page.evaluate(
    (before) => window.__cutuRafCallbacks - before,
    rafBefore,
  );
  console.log(
    "Actual animation callbacks:",
    JSON.stringify(renderMeasurements),
  );
  expect(renderMeasurements.idleCallbacksPerSecond).toBe(0);
  expect(renderMeasurements.orbitCallbacks).toBeGreaterThan(0);
  expect(renderMeasurements.playCallbacksPerSecond).toBeGreaterThan(0);
  expect(renderMeasurements.pausedCallbacksPerSecond).toBe(0);
  expect(renderMeasurements.orbitChangesPixels).toBe(true);
  expect(renderMeasurements.gaitChangesPixels).toBe(true);
  await capture(
    "01-assembly",
    "Makada assembly · default workspace",
    "Native model loaded; navigation disclosures, source and specialized panels closed.",
  );
  await page.getByRole("button", { name: /^Objects/ }).click();
  await page
    .getByRole("button", { name: "Left walking servo", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Selected object" }),
  ).toBeVisible();
  await capture(
    "02-selection",
    "Shared selection and inspector",
    "Actual left servo selection, contextual properties and assembly highlight.",
  );
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page.getByRole("button", { name: /^Objects/ }).click();
  await page
    .getByRole("button", { name: "Current project", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menu").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await capture(
    "03-project-menu",
    "Myui project menu",
    "Actual portaled project picker with current project indicator.",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await choose("Starting point", "Makada · walking robot");
  await page
    .getByRole("textbox", { name: "Project name" })
    .fill("A new hardware idea");
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture(
    "04-create-project",
    "Create project dialog",
    "Real Myui dialog and template dropdown; no project created for this screenshot.",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
  await expect(page.locator(".es-canvas svg").first()).toBeVisible({
    timeout: 150_000,
  });
  await expect(
    page.getByRole("button", { name: "Review", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await capture(
    "05-circuit-clean",
    "Circuit · schematic canvas",
    "Real compiled schematic with parts and review closed.",
  );
  await page.getByRole("button", { name: "Parts", exact: true }).click();
  const partSearch = page.getByRole("textbox", {
    name: "Search placed parts",
    exact: true,
  });
  await partSearch.fill("LEFT");
  await expect(page.locator(".es-palette-item")).toHaveCount(1);
  await expect(page.locator(".es-palette-item")).toContainText("LEFT");
  await partSearch.fill("");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Fit to view", exact: true }).click();
  await capture(
    "06-circuit-review",
    "Circuit · requested details",
    "Parts browser and design review opened explicitly; actual findings shown.",
  );
  await page.getByRole("tab", { name: "CAD", exact: true }).click();
  await expect(page.locator(".replicad-status")).toHaveText(/Compiled in/, {
    timeout: 150_000,
  });
  await expect(page.locator(".replicad-code-pane")).not.toBeVisible();
  await capture(
    "07-cad-visual",
    "CAD · visual default",
    "Real OpenCascade compiled model; source, parts and parameters closed.",
  );
  await page.getByRole("button", { name: "Parameters", exact: true }).click();
  await capture(
    "08-cad-parameters",
    "CAD · parameters on demand",
    "Original parameter controls beside the real CAD viewport.",
  );
  await page.getByRole("button", { name: "Parameters", exact: true }).click();
  await page.getByRole("tab", { name: "Assembly", exact: true }).click();
  await page
    .getByRole("button", { name: "Project capabilities", exact: true })
    .click();
  await choose("Capability", "Inspect hardware");
  await capture(
    "09-capabilities",
    "Project capabilities",
    "Inspectable offline program capability; physical hardware is not connected.",
  );
  await page
    .getByRole("button", { name: "Run Inspect hardware", exact: true })
    .click();
  const operation = page.locator(".operation-list section").first();
  await expect(operation).toContainText("Succeeded");
  await operation.getByText("View output", { exact: true }).click();
  await expect(operation.locator("pre")).toContainText("project-files");
  await capture(
    "10-operation-output",
    "Real operation output",
    "Completed Inspect hardware program and its actual project-files telemetry.",
  );
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page
    .getByRole("button", { name: "Codex connection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Codex connection", exact: true }),
  ).toBeVisible();
  await capture(
    "11-codex",
    "Codex connection",
    "Real plugin connection information and installation path; no simulated chat.",
  );
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page
    .getByRole("button", { name: "Workspace actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit source files", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Native source editor" }),
  ).toBeEnabled();
  await capture(
    "12-explicit-source",
    "Source · explicit reveal",
    "Native authoring source appears only after selecting Edit source files.",
  );
  await page.getByRole("tab", { name: "Assembly", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Toggle project navigation", exact: true })
    .click();
  await capture(
    "13-mobile-assembly",
    "Mobile · assembly default",
    "390 px viewport; real assembly canvas and compact navigation.",
  );
  await page
    .getByRole("button", { name: "Project capabilities", exact: true })
    .click();
  await capture(
    "14-mobile-capabilities",
    "Mobile · requested capability panel",
    "390 px viewport; action controls remain reachable in contextual panel.",
  );
} finally {
  await browser.close();
  await writeFile(
    path.join(output, "evidence.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        baseURL: base,
        reducedMotion: "reduce",
        projectId: project.id,
        entries,
        errors,
        renderMeasurements,
      },
      null,
      2,
    ),
  );
  const esc = (text) =>
    text.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cutu Circuits · actual rendered UI evidence</title><style>body{margin:0;padding:32px;background:#212121;color:#eeffff;font:15px/1.5 Inter,system-ui,sans-serif;max-width:1600px}h1{font-size:24px}p{color:#b8c1c1}nav{display:flex;flex-wrap:wrap;gap:12px}a{color:#80cbc4}figure{margin:40px 0}img{max-width:100%;height:auto;border:1px solid #3b3d3d;border-radius:12px}figcaption{margin:12px 0}strong{display:block;font-size:18px}</style><h1>Cutu Circuits · actual rendered UI</h1><p>Captured ${new Date().toISOString()} from the running application. Screenshots use real UI interactions, native compilation and actual program output. Desktop 1512 × 982; mobile 390 × 844; reduced motion enabled. No UI substitutions or style injection.</p><nav>${entries.map((e) => `<a href="#${e.name}">${esc(e.caption)}</a>`).join("")}</nav>${entries.map((e) => `<figure id="${e.name}"><a href="${e.name}.png"><img src="${e.name}.png" alt="${esc(e.caption)}" loading="lazy"></a><figcaption><strong>${esc(e.caption)}</strong>${esc(e.evidence)} (${e.viewport.width} × ${e.viewport.height}; horizontal page overflow: ${e.overflow ? "yes" : "no"}.)</figcaption></figure>`).join("")}<p>Browser page errors recorded: ${errors.length}. Inspect evidence.json for the capture manifest.</p></html>`,
  );
}
