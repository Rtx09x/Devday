import { test, expect } from "@playwright/test";

async function openAgent(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  configured = false,
  pending = false,
) {
  const response = await request.post("http://127.0.0.1:4310/api/projects", {
    data: { name: `Agent UI fixture ${Date.now()}`, template: "blank" },
  });
  expect(response.ok()).toBeTruthy();
  const project = await response.json();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(
    (id) => localStorage.setItem("cutucircuits:active-project", id),
    project.id,
  );
  await page.route("**/api/projects/*/agent/status", (route) =>
    route.fulfill({
      json: {
        configured,
        searchConfigured: configured,
        model: "qwen-3.8-27b",
        history: [],
        tools: [],
        activeTurnId: pending ? "fixture-turn" : null,
        pendingApproval: pending
          ? {
              approvalId: "fixture-approval",
              callId: "fixture-call",
              turnId: "fixture-turn",
              name: "write_file",
              args: {
                path: "notes.txt",
                content: "reviewed change",
                expectedSha256: null,
              },
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            }
          : null,
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cutu agent", exact: true }).click();
  return page.getByRole("region", {
    name: "Cutu workspace agent",
    exact: true,
  });
}
test("agent sidebar clearly exposes missing backend configuration and Codex connection", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request);
  await expect(
    panel.getByText("Connect Cerebras to get started", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Connect Codex for larger tasks",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Codex connection", exact: true }),
  ).toBeVisible();
});
test("agent sidebar consumes fixture SSE and shows text and source evidence", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request, true);
  await page.route("**/api/projects/*/agent/turns", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'event: start\ndata: {"turnId":"fixture-turn"}\n\nevent: text_delta\ndata: {"turnId":"fixture-turn","delta":"Verified fixture "}\n\nevent: citations\ndata: {"turnId":"fixture-turn","sources":[{"id":"S1","url":"https://example.com/datasheet","title":"Fixture datasheet"}]}\n\nevent: complete\ndata: {"turnId":"fixture-turn","text":"Verified fixture response [S1]."}\n\n',
    }),
  );
  await panel
    .getByRole("textbox", { name: "Ask Cutu", exact: true })
    .fill("Inspect this fixture project.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    panel.getByText("Verified fixture response [S1].", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "S1 · Fixture datasheet", exact: true }),
  ).toHaveAttribute("href", "https://example.com/datasheet");
});
test("agent approvals display exact arguments and require a separate explicit action", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request, true, true);
  let decision: unknown;
  await page.route("**/api/projects/*/agent/approvals/*", async (route) => {
    decision = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  const approval = panel.getByRole("region", {
    name: "Approve agent action",
    exact: true,
  });
  await expect(approval).toContainText("notes.txt");
  expect(decision).toBeUndefined();
  await approval
    .getByRole("button", { name: "Approve action", exact: true })
    .click();
  await expect(approval).toHaveCount(0);
  expect(decision).toEqual({ approved: true });
});

test("agent composer previews, removes and sends a bounded image attachment", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request, true);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
    "base64",
  );
  const picker = panel.locator('input[type="file"]');
  await picker.setInputFiles({
    name: "controller.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    panel.getByRole("button", { name: "Remove controller.png", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Remove controller.png", exact: true })
    .click();
  await expect(panel.locator(".agent-attachments")).toHaveCount(0);
  await picker.setInputFiles({
    name: "controller.png",
    mimeType: "image/png",
    buffer: png,
  });
  let payload: any;
  await page.route("**/api/projects/*/agent/turns", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: complete\ndata: {"turnId":"fixture-image","text":"Image fixture received."}\n\n',
    });
  });
  await panel
    .getByRole("textbox", { name: "Ask Cutu", exact: true })
    .fill("Check this controller image.");
  await panel
    .getByRole("textbox", { name: "Ask Cutu", exact: true })
    .press("Shift+Enter");
  await expect(
    panel.getByRole("textbox", { name: "Ask Cutu", exact: true }),
  ).toHaveValue("Check this controller image.\n");
  expect(payload).toBeUndefined();
  await panel
    .getByRole("textbox", { name: "Ask Cutu", exact: true })
    .press("Enter");
  await expect(
    panel.getByText("Image fixture received.", { exact: true }),
  ).toBeVisible();
  expect(payload.message).toBe("Check this controller image.");
  expect(payload.attachments).toEqual([
    {
      name: "controller.png",
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    },
  ]);
  await expect(panel.locator(".agent-message-images img")).toHaveAttribute(
    "alt",
    "controller.png",
  );
});

test("agent composer rejects unsupported files and too many images", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request, true);
  const picker = panel.locator('input[type="file"]');
  await picker.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(panel.getByRole("alert")).toHaveText(
    "Choose PNG or JPEG images.",
  );
  await picker.setInputFiles(
    [1, 2, 3].map((index) => ({
      name: `${index}.png`,
      mimeType: "image/png",
      buffer: Buffer.from("x"),
    })),
  );
  await expect(panel.getByRole("alert")).toHaveText(
    "Attach up to two images per message.",
  );
  await expect(panel.locator(".agent-attachments")).toHaveCount(0);
});

test("agent composer discards provisional text when the server rejects a turn", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request, true);
  await page.route("**/api/projects/*/agent/turns", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'event: text_delta\ndata: {"turnId":"fixture-error","delta":"Unverified partial answer"}\n\nevent: error\ndata: {"turnId":"fixture-error","discardText":true,"message":"Provider fixture failed"}\n\n',
    }),
  );
  await panel
    .getByRole("textbox", { name: "Ask Cutu", exact: true })
    .fill("Inspect the project.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Provider fixture failed");
  await expect(
    panel.getByText("Unverified partial answer", { exact: true }),
  ).toHaveCount(0);
});

test("conversation yields navigation space and restores project navigation in one click", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 903, height: 540 });
  const panel = await openAgent(page, request);
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Project navigation" }),
  ).toBeHidden();
  const design = await page.locator(".main").boundingBox();
  expect(design!.width).toBeGreaterThan(450);
  await page
    .getByRole("button", { name: "Toggle project navigation", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole("complementary", { name: "Project navigation" }),
  ).toBeVisible();
});

test("agent answers render Markdown without raw HTML, unsafe links or remote images", async ({
  page,
  request,
}) => {
  const panel = await openAgent(page, request, true);
  const text =
    '# Wiring review\n\n**Check these pins** [S1]\n\n- D5: `GPIO14`\n- D6: `GPIO12`\n\n```cpp\nservo.attach(14);\n```\n\n| Pin | GPIO |\n| --- | --- |\n| D7 | 13 |\n\n[Manufacturer](https://example.com/pinout)\n\n[Unsafe](javascript:alert%281%29)\n\n![tracker](https://example.com/tracking.png)\n\n<img src="x" onerror="window.markdownExecuted=true">\n\n<script>window.markdownExecuted=true</script>';
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("tracking.png"))
      remoteRequests.push(request.url());
  });
  await page.route("**/api/projects/*/agent/turns", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: complete\ndata: ${JSON.stringify({ turnId: "fixture-markdown", text })}\n\n`,
    }),
  );
  await panel
    .getByRole("textbox", { name: "Ask Cutu", exact: true })
    .fill("Review the wiring.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    panel.getByRole("heading", { name: "Wiring review", exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".agent-markdown strong")).toHaveText(
    "Check these pins",
  );
  await expect(panel.locator(".agent-markdown li")).toHaveCount(2);
  await expect(panel.locator(".agent-markdown pre code")).toContainText(
    "servo.attach(14);",
  );
  await expect(panel.getByRole("table")).toContainText("D7");
  await expect(
    panel.getByRole("link", { name: "Manufacturer", exact: true }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    panel.getByRole("link", { name: "Unsafe", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.locator(".agent-markdown img,.agent-markdown script"),
  ).toHaveCount(0);
  expect(remoteRequests).toEqual([]);
  expect(
    await page.evaluate(() => Boolean((window as any).markdownExecuted)),
  ).toBe(false);
});
