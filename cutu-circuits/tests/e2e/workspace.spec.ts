import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type {
  Project,
  FileSnapshot,
  Operation,
} from "../../packages/core/src/index";
import { readFile } from "node:fs/promises";
const runtime = "http://127.0.0.1:4310/api";
async function create(
  request: APIRequestContext,
  template: "blank" | "sensor" | "spidey" = "sensor",
) {
  const response = await request.post(`${runtime}/projects`, {
    data: {
      name: `QA ${template} ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`,
      template,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as Project;
}
async function open(page: Page, project: Project) {
  page.setDefaultTimeout(20_000);
  await page.addInitScript(
    (id) => localStorage.setItem("cutucircuits:active-project", id),
    project.id,
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
}
async function revealSource(page: Page) {
  await page
    .getByRole("button", { name: "Workspace actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit source files", exact: true })
    .click();
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function switchProject(page: Page, project: Project) {
  await page
    .getByRole("button", { name: "Current project", exact: true })
    .click();
  await page.getByRole("menuitem", { name: project.name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
}
async function snapshot(
  request: APIRequestContext,
  project: Project,
  path: string,
) {
  const response = await request.get(
    `${runtime}/projects/${project.id}/files`,
    { params: { path } },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as FileSnapshot;
}
async function tools(request: APIRequestContext, project: Project) {
  const response = await request.get(
    `${runtime}/projects/${project.id}/editor-tools`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    name: string;
    sessionId: string;
    sha256: string;
  }[];
}

test("project creation, switching and shared assembly selection use the authoritative runtime", async ({
  page,
  request,
}) => {
  const project = await create(request, "spidey");
  await open(page, project);
  await page.getByRole("button", { name: /^Objects/ }).click();
  await page
    .getByRole("button", { name: "Left walking servo", exact: true })
    .click();
  await expect(page.locator(".inspector")).toContainText("Left walking servo");
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`${runtime}/projects/${project.id}/selection`)
          ).json()
        ).entityId,
    )
    .toBe("servo-left");
  await request.put(`${runtime}/projects/${project.id}/selection`, {
    data: { entityId: "servo-right", origin: "codex" },
  });
  await expect(page.locator(".inspector")).toContainText("Right walking servo");
  await expect(page.locator(".workspace-footer")).toContainText(
    "Selection from Codex",
  );
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Project name" })
    .fill(`UI-created ${project.id}`);
  await choose(page, "Starting point", "Blank workspace");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `UI-created ${project.id}`,
      exact: true,
    }),
  ).toBeVisible();
  await switchProject(page, project);
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".inspector")).toContainText("Right walking servo");
});

test("Makada assembly opens still with walking and replay controls hidden", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const project = await create(request, "spidey");
  await open(page, project);
  const scene = page.locator(".scene");
  await expect(scene).toHaveAttribute("data-preview-distance-mm", "0");
  await expect(scene).toHaveAttribute("data-preview-offset", "[0,0,0]");
  await expect(
    page.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Replay assembly", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Building Makada", exact: true }),
  ).toHaveCount(0);
});

test("native source CAS save survives reload and external edits preserve unsaved work", async ({
  page,
  request,
}) => {
  const project = await create(request);
  await open(page, project);
  await revealSource(page);
  const editor = page.getByRole("textbox", { name: "Native source editor" });
  await expect(editor).toBeEnabled();
  const original = await editor.inputValue();
  const saved = `${original}\n// Saved from browser QA\n`;
  await editor.fill(saved);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeDisabled();
  expect(
    (await snapshot(request, project, "circuit.circuit.tsx")).content,
  ).toBe(saved);
  await page.reload();
  await revealSource(page);
  await expect(editor).toHaveValue(saved);
  const local = `${saved}// Unsaved local change\n`;
  await editor.fill(local);
  const latest = await snapshot(request, project, "circuit.circuit.tsx");
  const external = `${saved}// Saved by another client\n`;
  const response = await request.put(
    `${runtime}/projects/${project.id}/files`,
    {
      data: {
        path: latest.path,
        content: external,
        expectedSha256: latest.sha256,
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  await expect(
    page.getByRole("alert").filter({ hasText: "This file changed outside" }),
  ).toBeVisible();
  const rejectedSave = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${project.id}/files`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await rejectedSave).status()).toBe(409);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /changed|conflict/i })
      .first(),
  ).toBeVisible();
  await expect(editor).toHaveValue(local);
  expect((await snapshot(request, project, latest.path)).content).toBe(
    external,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Reload latest", exact: true })
    .click();
  await expect(editor).toHaveValue(external);
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeDisabled();
});

test("real native circuit and CAD editors mount and expose their 67 + 6 executable tools", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const project = await create(request, "spidey");
  await open(page, project);
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
  const nativeError = page.getByRole("heading", {
    name: "The native editor could not open",
    exact: true,
  });
  await expect(page.locator(".es-canvas").or(nativeError)).toBeVisible({
    timeout: 90_000,
  });
  expect(
    await nativeError.isVisible(),
    "Native circuit module must load without the fallback error boundary",
  ).toBe(false);
  await expect
    .poll(
      async () =>
        (await tools(request, project)).filter((t) =>
          t.name.startsWith("electronics."),
        ).length,
      { timeout: 90_000 },
    )
    .toBeGreaterThanOrEqual(67);
  const electronics = (await tools(request, project)).find(
    (t) => t.name === "electronics.runtime_status",
  )!;
  expect(electronics).toBeTruthy();
  const read = await request.post(
    `${runtime}/projects/${project.id}/editor-tools/electronics.runtime_status`,
    {
      data: {
        sessionId: electronics.sessionId,
        params: {},
        expectedSha256: electronics.sha256,
      },
      timeout: 30_000,
    },
  );
  expect(read.ok(), await read.text()).toBeTruthy();
  expect((await read.json()).success).toBe(true);
  await expect
    .poll(
      async () => {
        const response = await request.post(
          `${runtime}/projects/${project.id}/editor-tools/electronics.describe_part`,
          {
            data: { sessionId: electronics.sessionId, params: { ref: "LEFT" } },
            timeout: 30_000,
          },
        );
        return response.ok() && (await response.json()).success;
      },
      { timeout: 90_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await expect(page.locator(".es-canvas svg").first()).toBeVisible({
    timeout: 90_000,
  });
  await page.screenshot({
    path: test.info().outputPath("native-circuit.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "CAD", exact: true }).click();
  await expect(page.locator(".replicad-editor").or(nativeError)).toBeVisible({
    timeout: 90_000,
  });
  expect(
    await nativeError.isVisible(),
    "Native CAD module must load without the fallback error boundary",
  ).toBe(false);
  await expect
    .poll(async () => (await tools(request, project)).length, {
      timeout: 90_000,
    })
    .toBeGreaterThanOrEqual(6);
  await page.getByRole("button", { name: "Parts", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Shapes", exact: true }),
  ).toContainText("servo-left", { timeout: 90_000 });
  await page.getByRole("button", { name: "servo-left", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`${runtime}/projects/${project.id}/selection`)
          ).json()
        ).entityId,
    )
    .toBe("servo-left");
  const cad = (await tools(request, project)).find(
    (t) => t.name === "get_selection",
  )!;
  expect(cad).toBeTruthy();
  const selection = await request.post(
    `${runtime}/projects/${project.id}/editor-tools/get_selection`,
    {
      data: {
        sessionId: cad.sessionId,
        params: {},
        expectedSha256: cad.sha256,
      },
      timeout: 30_000,
    },
  );
  expect(selection.ok(), await selection.text()).toBeTruthy();
  const selected = await selection.json();
  expect(selected.success).toBe(true);
  expect(selected.data.shapeName).toBe("servo-left");
  await page.screenshot({
    path: test.info().outputPath("native-cad.png"),
    fullPage: true,
  });
});

test("saved circuit and CAD sources compile and produce real SVG and STEP downloads", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const project = await create(request);
  await open(page, project);
  await revealSource(page);
  await expect(
    page.getByRole("textbox", { name: "Native source editor" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await expect(
    page.locator(".compile-result").or(page.getByRole("alert")),
  ).toBeVisible({ timeout: 90_000 });
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  await expect(page.locator(".compile-result")).toContainText("components");
  const circuitDownload = page.waitForEvent("download", { timeout: 90_000 });
  await page
    .getByRole("button", { name: "Export format", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "SVG", exact: true }).click();
  const svg = await circuitDownload;
  expect(svg.suggestedFilename()).toMatch(/\.svg$/);
  expect(await svg.failure()).toBeNull();
  expect(await readFile((await svg.path())!, "utf8")).toContain("<svg");
  await choose(
    page,
    "Source file",
    project.assets.find((asset) => asset.kind === "cad")!.name,
  );
  await expect(
    page.getByRole("textbox", { name: "Native source editor" }),
  ).toHaveValue(/defaultParams/);
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await expect(
    page.locator(".compile-result").or(page.getByRole("alert")),
  ).toBeVisible({ timeout: 90_000 });
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  await expect(page.locator(".compile-result")).toContainText("1 shapes");
  const cadDownload = page.waitForEvent("download", { timeout: 90_000 });
  await page
    .getByRole("button", { name: "Export format", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "STEP", exact: true }).click();
  const step = await cadDownload;
  expect(step.suggestedFilename()).toMatch(/\.step$/);
  expect(await step.failure()).toBeNull();
  expect(await readFile((await step.path())!, "utf8")).toContain(
    "ISO-10303-21",
  );
});

test("offline hardware program telemetry is real and a running preview can be cancelled", async ({
  page,
  request,
}) => {
  const project = await create(request, "spidey");
  await open(page, project);
  await page
    .getByRole("button", { name: "Project capabilities", exact: true })
    .click();
  await choose(page, "Capability", "Inspect hardware");
  await page
    .getByRole("button", { name: "Run Inspect hardware", exact: true })
    .click();
  await expect(page.locator(".operation-list section").first()).toContainText(
    "Succeeded",
  );
  await page
    .locator(".operation-list section")
    .first()
    .getByText("View output", { exact: true })
    .click();
  await expect(page.locator(".operation-list section").first()).toContainText(
    "project-files",
  );
  await choose(page, "Capability", "Preview gait");
  await page.getByLabel("Phase Ms", { exact: true }).fill("2000");
  await page
    .getByRole("button", { name: "Run Preview gait", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel operation", exact: true }),
  ).toBeVisible();
  await page
    .locator(".operation-list section")
    .first()
    .getByText("View output", { exact: true })
    .click();
  await expect(page.locator(".operation-list section").first()).toContainText(
    "offline-preview",
  );
  await page
    .getByRole("button", { name: "Cancel operation", exact: true })
    .click();
  await expect(page.locator(".operation-list section").first()).toContainText(
    "Cancelled",
  );
  const operations = (await (
    await request.get(`${runtime}/projects/${project.id}/operations`)
  ).json()) as Operation[];
  expect(
    operations.some(
      (o) => o.capabilityId === "inspect" && o.status === "succeeded",
    ),
  ).toBe(true);
  expect(
    operations.some(
      (o) => o.capabilityId === "gait-preview" && o.status === "cancelled",
    ),
  ).toBe(true);
});

test("mobile navigation and contextual controls remain reachable without page overflow", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await create(request, "spidey");
  await open(page, project);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(await overflow()).toBe(false);
  await page
    .getByRole("button", { name: "Toggle project navigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Current project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  expect(await overflow()).toBe(false);
  await page
    .getByRole("button", { name: "Toggle project navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Project capabilities", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Capability", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run Inspect hardware", exact: true }),
  ).toBeInViewport();
  expect(await overflow()).toBe(false);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await revealSource(page);
  await expect(
    page.getByRole("textbox", { name: "Native source editor" }),
  ).toBeVisible();
  expect(await overflow()).toBe(false);
});

test("original electronics write tool automatically persists native edits with its observed hash", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const project = await create(request);
  await open(page, project);
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
  const nativeError = page.getByRole("heading", {
    name: "The native editor could not open",
    exact: true,
  });
  await expect(page.locator(".es-canvas").or(nativeError)).toBeVisible({
    timeout: 90_000,
  });
  expect(await nativeError.isVisible()).toBe(false);
  await expect
    .poll(async () => (await tools(request, project)).length, {
      timeout: 90_000,
    })
    .toBeGreaterThanOrEqual(67);
  const tool = (await tools(request, project)).find(
    (t) => t.name === "electronics.update_part",
  )!;
  expect(tool).toBeTruthy();
  await expect
    .poll(
      async () => {
        const response = await request.post(
          `${runtime}/projects/${project.id}/editor-tools/electronics.describe_part`,
          {
            data: { sessionId: tool.sessionId, params: { ref: "R1" } },
            timeout: 30_000,
          },
        );
        return response.ok() && (await response.json()).success;
      },
      { timeout: 90_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  const before = await snapshot(request, project, "circuit.circuit.tsx");
  const writeRequest = page.waitForRequest(
    (r) =>
      r.url().endsWith(`/projects/${project.id}/files`) && r.method() === "PUT",
  );
  const response = await request.post(
    `${runtime}/projects/${project.id}/editor-tools/electronics.update_part`,
    {
      data: {
        sessionId: tool.sessionId,
        expectedSha256: before.sha256,
        params: { name: "R1", value: "22k" },
      },
      timeout: 30_000,
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const result = await response.json();
  expect(result.success, JSON.stringify(result)).toBe(true);
  const save = page
    .locator(".cutucircuits-native-editor-actions")
    .getByRole("button", { name: "Save", exact: true });
  expect((await writeRequest).postDataJSON().expectedSha256).toBe(
    before.sha256,
  );
  await expect(save).toBeHidden();
  await expect(
    page.locator(".cutucircuits-native-editor-actions"),
  ).toHaveAttribute("data-dirty", "false");
  await expect
    .poll(async () => (await snapshot(request, project, before.path)).content)
    .toMatch(/resistance=["']22k["']/);
  expect((await snapshot(request, project, before.path)).sha256).not.toBe(
    before.sha256,
  );
  await page.screenshot({
    path: test.info().outputPath("native-circuit-saved.png"),
    fullPage: true,
  });
});

test("visual defaults keep native code and circuit review closed until explicitly requested", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const project = await create(request, "spidey");
  await open(page, project);
  await expect(
    page.getByRole("textbox", { name: "Native source editor" }),
  ).toBeHidden();
  await page.getByRole("tab", { name: "CAD", exact: true }).click();
  await expect(page.locator(".replicad-status")).toHaveText(/Compiled in/, {
    timeout: 90_000,
  });
  await expect(page.locator(".replicad-code-pane")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Parameters", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Parts", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".replicad-code-pane")).toBeVisible();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
  await expect(page.locator(".es-canvas svg").first()).toBeVisible({
    timeout: 90_000,
  });
  const review = page.getByRole("button", { name: "Review", exact: true });
  await expect(review).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".es-advisor")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Parts", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await review.click();
  await expect(review).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".es-advisor")).toBeVisible();
});

test("Myui menus and dialogs support keyboard dismissal and restore trigger focus", async ({
  page,
  request,
}) => {
  const project = await create(request);
  await open(page, project);
  const picker = page.getByRole("button", {
    name: "Current project",
    exact: true,
  });
  await picker.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: project.name, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(picker).toBeFocused();
  const actions = page.getByRole("button", {
    name: "Workspace actions",
    exact: true,
  });
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "Edit source files", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Project name" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeFocused();
});

test("delayed old-project selection events cannot replace the current project's state", async ({
  page,
  request,
}) => {
  const old = await create(request, "spidey");
  const current = await create(request, "spidey");
  await request.put(`${runtime}/projects/${current.id}/selection`, {
    data: { entityId: "servo-left", origin: "workspace" },
  });
  await open(page, old);
  let release!: () => void;
  let intercepted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/projects/${old.id}/selection`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    intercepted();
    await gate;
    await route.fulfill({ response });
  });
  await request.put(`${runtime}/projects/${old.id}/selection`, {
    data: { entityId: "servo-right", origin: "codex" },
  });
  await waiting;
  await switchProject(page, current);
  await expect(page.locator(".inspector")).toContainText("Left walking servo");
  const delivered = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${old.id}/selection`) &&
      response.request().method() === "GET",
  );
  release();
  await (await delivered).finished();
  await page.unrouteAll({ behavior: "wait" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".inspector")).toContainText("Left walking servo");
  await expect(page.locator(".workspace-footer")).not.toContainText(
    "Selection from Codex",
  );
});

test("browser offline recovery reconciles missed external selection and clean source changes", async ({
  page,
  request,
  context,
}) => {
  const project = await create(request, "spidey");
  await open(page, project);
  await revealSource(page);
  const editor = page.getByRole("textbox", { name: "Native source editor" });
  await expect(editor).toBeEnabled();
  const before = await snapshot(request, project, "circuit.circuit.tsx");
  await context.setOffline(true);
  const content = `${before.content}\n// Changed while browser disconnected\n`;
  const saved = await request.put(`${runtime}/projects/${project.id}/files`, {
    data: { path: before.path, content, expectedSha256: before.sha256 },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await request.put(`${runtime}/projects/${project.id}/selection`, {
    data: { entityId: "servo-right", origin: "codex" },
  });
  await context.setOffline(false);
  await expect(editor).toHaveValue(content, { timeout: 30_000 });
  await expect(page.locator(".workspace-footer")).toContainText(
    "Selection from Codex",
  );
  await expect(page.getByRole("alert")).toBeHidden();
});

test("reduced motion and mobile contextual controls stay readable inside the viewport", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await create(request, "spidey");
  await open(page, project);
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Project capabilities", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Run Inspect hardware", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const taskPanel = page.locator(".task-panel");
  const controls = await taskPanel
    .getByRole("button")
    .or(taskPanel.getByRole("combobox"))
    .or(taskPanel.getByRole("textbox"))
    .or(taskPanel.getByRole("spinbutton"))
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node),
          rect = node.getBoundingClientRect();
        return {
          text: node.textContent?.trim(),
          font: parseFloat(style.fontSize),
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
        };
      }),
    );
  expect(controls.length).toBeGreaterThan(1);
  for (const control of controls) {
    expect(control.font, JSON.stringify(control)).toBeGreaterThanOrEqual(12);
    expect(control.height, JSON.stringify(control)).toBeGreaterThanOrEqual(28);
    expect(control.left, JSON.stringify(control)).toBeGreaterThanOrEqual(0);
    expect(control.right, JSON.stringify(control)).toBeLessThanOrEqual(391);
  }
});
