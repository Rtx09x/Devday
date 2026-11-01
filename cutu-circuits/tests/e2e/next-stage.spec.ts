import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { FileHistoryEntry, FileHistoryVersion, FileSnapshot, Project } from "../../packages/core/src/index";
import type { RobotSnapshot } from "../../packages/robotics/src/types";
import { readFile } from "node:fs/promises";

const runtime = "http://127.0.0.1:4310/api";
async function create(request: APIRequestContext, template = "sensor") {
  const response = await request.post(`${runtime}/projects`, {
    data: { name: `Next-stage ${template} ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`, template },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as Project;
}
async function open(page: Page, project: Project) {
  await page.addInitScript((id) => localStorage.setItem("cutucircuits:active-project", id), project.id);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
}
async function snapshot(request: APIRequestContext, project: Project, path = "circuit.circuit.tsx") {
  const response = await request.get(`${runtime}/projects/${project.id}/files`, { params: { path } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as FileSnapshot;
}
async function save(request: APIRequestContext, project: Project, previous: FileSnapshot, content: string) {
  const response = await request.put(`${runtime}/projects/${project.id}/files`, {
    data: { path: previous.path, content, expectedSha256: previous.sha256 },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as FileSnapshot;
}
async function history(request: APIRequestContext, project: Project, path: string) {
  const response = await request.get(`${runtime}/projects/${project.id}/history`, { params: { path, limit: 100 } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as FileHistoryEntry[];
}
async function openHistory(page: Page) {
  await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Version history", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Version history", exact: true })).toBeVisible();
}
async function revealSource(page: Page) {
  await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit source files", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Native source editor" })).toBeEnabled();
}
async function physicsSnapshot(page: Page): Promise<RobotSnapshot> {
  return JSON.parse(await page.getByTestId("robot-snapshot").getAttribute("data-physics-snapshot") ?? "null");
}
async function robotPixels(page: Page) {
  return page.locator(".cutu-robot-viewport canvas").screenshot({
    mask: [page.locator(".cutu-robot-toolbar, .cutu-robot-caption, .cutu-robot-panel, .cutu-robot-bottom, .cutu-robot-selection")],
    maskColor: "#212121",
  });
}

test("version history compares immutable saved content and restores the actual native file", async ({ page, request }) => {
  const project = await create(request);
  const original = await snapshot(request, project);
  const changed = await save(request, project, original, `${original.content}\n// A later saved revision\n`);
  const versions = await history(request, project, original.path);
  const baseline = versions.find((entry) => entry.reason === "baseline" && entry.sha256 === original.sha256);
  expect(baseline).toBeTruthy();
  await open(page, project);
  await expect(page.getByRole("dialog", { name: "Version history", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Native source editor" })).toBeHidden();
  await expect(page.locator(".task-panel")).toBeHidden();
  await openHistory(page);
  await page.getByRole("button", { name: /^Original version/ }).click();
  const comparison = page.getByRole("region", { name: "Version comparison", exact: true });
  await expect(comparison.locator(".history-added")).toContainText("A later saved revision");
  await page.getByRole("tab", { name: "Saved version", exact: true }).click();
  await expect(page.getByLabel("Saved version content", { exact: true })).toHaveText(original.content);
  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  await expect(page.getByText(`Replace ${original.path} with this version?`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm restore", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Version restored" })).toBeVisible();
  expect(await snapshot(request, project)).toEqual(original);
  const after = await history(request, project, original.path);
  expect(after.some((entry) => entry.reason === "restore" && entry.sha256 === original.sha256)).toBe(true);
  expect(after.some((entry) => entry.sha256 === changed.sha256)).toBe(true);
  const retained = await request.get(`${runtime}/projects/${project.id}/history/${baseline!.id}`);
  expect((await retained.json() as FileHistoryVersion).content).toBe(original.content);
  await page.reload();
  await revealSource(page);
  await expect(page.getByRole("textbox", { name: "Native source editor" })).toHaveValue(original.content);
});

test("a stale history restore is rejected and preserves a newer file saved during confirmation", async ({ page, request }) => {
  const project = await create(request);
  const original = await snapshot(request, project);
  const current = await save(request, project, original, `${original.content}\n// Previewed current version\n`);
  const latestContent = `${original.content}\n// Newer save must survive the stale restore\n`;
  await open(page, project);
  await openHistory(page);
  await page.getByRole("button", { name: /^Original version/ }).click();
  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  let requestHash: string | undefined;
  await page.route(`**/api/projects/${project.id}/history/*/restore`, async (route) => {
    requestHash = route.request().postDataJSON().expectedSha256;
    await save(request, project, current, latestContent);
    await route.continue();
  });
  const restoring = page.waitForResponse((response) => response.url().includes(`/projects/${project.id}/history/`) && response.url().endsWith("/restore"));
  await page.getByRole("button", { name: "Confirm restore", exact: true }).click();
  expect((await restoring).status()).toBe(409);
  expect(requestHash).toBe(current.sha256);
  expect((await snapshot(request, project)).content).toBe(latestContent);
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await expect(page.getByLabel("Changes from selected version to current file", { exact: true })).toContainText("Newer save must survive");
});

test("history preserves a local draft and disables restoration until it is saved or discarded", async ({ page, request }) => {
  const project = await create(request);
  const original = await snapshot(request, project);
  await save(request, project, original, `${original.content}\n// Saved revision before draft\n`);
  await open(page, project);
  await revealSource(page);
  const editor = page.getByRole("textbox", { name: "Native source editor" });
  const draft = `${await editor.inputValue()}// Unsaved local draft\n`;
  await editor.fill(draft);
  await openHistory(page);
  await page.getByRole("button", { name: /^Original version/ }).click();
  await expect(page.getByText("Save or discard your editor changes before restoring. Your draft is preserved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore this version", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveValue(draft);
  expect((await snapshot(request, project)).content).not.toContain("Unsaved local draft");
});

test("the robot template renders a real URDF and physics motors obey its authored joint limits and reset", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, await create(request, "blank"));
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const name = `UI robot ${Date.now()}`;
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill(name);
  await page.getByRole("combobox", { name: "Starting point", exact: true }).click();
  await page.getByRole("option", { name: "Robot · URDF + physics", exact: true }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Robot", exact: true }).click();
  const workspace = page.getByRole("region", { name: "Robot workspace", exact: true });
  const canvas = page.getByRole("region", { name: "Cutu two-axis arm URDF viewport", exact: true }).locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(workspace).toContainText("3 links · 2 joints · metres");
  await expect(page.getByRole("complementary", { name: "Robot joints", exact: true })).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Robot settings", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Physics", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play physics", exact: true })).toBeEnabled();
  const initial = await physicsSnapshot(page);
  expect(initial.time).toBe(0);
  await page.getByRole("button", { name: /^Joints/ }).click();
  const shoulder = page.getByRole("slider", { name: "shoulder", exact: true });
  const extension = page.getByRole("slider", { name: "extension", exact: true });
  await expect(shoulder).toHaveAttribute("min", "-1.2");
  await expect(shoulder).toHaveAttribute("max", "1.2");
  const before = await robotPixels(page);
  await shoulder.focus();
  await page.keyboard.press("End");
  await extension.focus();
  await page.keyboard.press("End");
  expect((await physicsSnapshot(page)).joints.shoulder.position).toBe(initial.joints.shoulder.position);
  await page.getByRole("button", { name: "Play physics", exact: true }).click();
  await expect.poll(async () => (await physicsSnapshot(page)).time).toBeGreaterThan(3);
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  const simulated = await physicsSnapshot(page);
  expect(simulated.joints.shoulder.target).toBe(1.2);
  expect(simulated.joints.extension.target).toBe(.16);
  expect(simulated.joints.shoulder.position).toBeGreaterThan(.5);
  expect(simulated.joints.shoulder.position).toBeLessThan(1.22);
  expect(simulated.joints.extension.position).toBeGreaterThan(.05);
  expect(simulated.joints.extension.position).toBeLessThan(.17);
  expect(simulated.contacts).toBeGreaterThan(0);
  expect(simulated.links.base).toEqual(initial.links.base);
  expect(before.equals(await robotPixels(page)), "Physics must change rendered robot pixels with all DOM controls masked").toBe(false);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  expect(await physicsSnapshot(page)).toEqual(initial);
  await page.getByRole("button", { name: "Step", exact: true }).click();
  expect((await physicsSnapshot(page)).time).toBeCloseTo(1 / 120, 8);
});

test("free-base physics visibly falls under gravity and its contextual controls remain accessible on mobile", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, await create(request, "robot"));
  await page.getByRole("tab", { name: "Robot", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Cutu two-axis arm URDF viewport", exact: true }).locator("canvas");
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Physics", exact: true }).click();
  await page.getByRole("button", { name: "Robot settings", exact: true }).click();
  await page.getByRole("switch", { name: "Fixed base", exact: true }).click();
  await page.getByRole("switch", { name: "Ground plane", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play physics", exact: true })).toBeEnabled();
  const initial = await physicsSnapshot(page);
  const before = await robotPixels(page);
  await page.getByRole("button", { name: "Play physics", exact: true }).click();
  await expect.poll(async () => (await physicsSnapshot(page)).links.base.position[2]).toBeLessThan(-.2);
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  const falling = await physicsSnapshot(page);
  expect(falling.time).toBeGreaterThan(.15);
  expect(falling.links.base.position[2]).toBeLessThan(initial.links.base.position[2] - .2);
  expect(before.equals(await robotPixels(page)), "Gravity must change rendered robot pixels with all DOM controls masked").toBe(false);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  expect(await physicsSnapshot(page)).toEqual(initial);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle project navigation", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Gravity", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Step", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Close robot panel", exact: true }).click();
  await page.getByRole("button", { name: /^Joints/ }).click();
  await expect(page.locator(".cutu-robot-joint").filter({ hasText: "shoulder" })).toBeInViewport();
});

test("importing a real local URDF file persists the native source and opens its articulated robot", async ({ page, request }) => {
  const project = await create(request, "blank");
  const nativeFile = "examples/robot/arm.urdf";
  const originalContent = await readFile(nativeFile, "utf8");
  await open(page, project);
  await expect(page.getByRole("tab", { name: "Robot", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import URDF", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import URDF", exact: true });
  await dialog.getByLabel("URDF file", { exact: true }).setInputFiles(nativeFile);
  await expect(dialog.getByRole("status")).toContainText("Cutu two-axis arm · 3 links · 2 joints");
  await dialog.getByRole("textbox", { name: "Project path", exact: true }).fill("robots/imported-arm.urdf");
  const importing = page.waitForResponse((response) => response.url().endsWith(`/projects/${project.id}/robotics/import`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Import robot", exact: true }).click();
  expect((await importing).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: "Robot", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Cutu two-axis arm URDF viewport", exact: true }).locator("canvas")).toBeVisible();
  const saved = await snapshot(request, project, "robots/imported-arm.urdf");
  expect(saved.content).toBe(originalContent);
  const updated = await (await request.get(`${runtime}/projects/${project.id}`)).json() as Project;
  expect(updated.assets.some(asset => asset.kind === "urdf" && asset.path === saved.path)).toBe(true);
  await page.reload();
  await page.getByRole("tab", { name: "Robot", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cutu two-axis arm URDF viewport", exact: true }).locator("canvas")).toBeVisible();
  expect((await snapshot(request, project, saved.path)).sha256).toBe(saved.sha256);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle project navigation", exact: true }).click();
  await revealSource(page);
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeInViewport();
  await page.getByRole("textbox", { name: "Native source editor" }).fill(`${originalContent}\n<!-- Unsaved mobile inspection draft -->\n`);
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Workspace actions", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("Makada URDF loads all native local STL resources and articulates their rendered geometry", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const project = await create(request, "spidey");
  const meshResponses: import("@playwright/test").Response[] = [];
  page.on("response", response => {
    if (response.url().includes(`/projects/${project.id}/assets/raw?path=`) && response.url().includes(".stl")) meshResponses.push(response);
  });
  await open(page, project);
  await page.getByRole("tab", { name: "Robot", exact: true }).click();
  await expect.poll(() => meshResponses.length).toBe(81);
  await Promise.all(meshResponses.map(async response => {
    expect(response.status(), response.url()).toBe(200);
    await response.finished();
    expect((await response.body()).byteLength).toBeGreaterThan(100);
  }));
  await expect(page.getByRole("region", { name: "Makada photo-informed hexapod URDF viewport", exact: true }).locator("canvas")).toBeVisible();
  await expect(page.locator(".cutu-robot-caption")).toContainText("4 links · 3 joints · metres");
  await page.getByRole("button", { name: /^Joints/ }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = await robotPixels(page);
  await page.getByRole("slider", { name: "left", exact: true }).focus();
  await page.keyboard.press("End");
  expect(before.equals(await robotPixels(page)), "The actual STL leg geometry must change with its URDF joint").toBe(false);
});
