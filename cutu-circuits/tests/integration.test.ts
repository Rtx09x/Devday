import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRuntime } from "../packages/runtime/src/server.ts";
import type {
  Project,
  FileSnapshot,
  Operation,
  CircuitResult,
  CadResult,
} from "@cutucircuits/core";

test(
  "packaged Codex plugin, real runtime, native engines and saved programs share one persisted project",
  { timeout: 120_000 },
  async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "cutucircuits-integration-"),
    );
    const runtime = await createRuntime({
      dataDir,
      seed: false,
      port: 0,
      pollIntervalMs: 25,
    });
    const server = await runtime.listen();
    const address = server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const client = new Client({
      name: "cutucircuits-integration",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL(
            "../plugins/cutucircuits/scripts/launch.mjs",
            import.meta.url,
          ),
        ),
      ],
      cwd: tmpdir(),
      env: {
        ...(process.env as Record<string, string>),
        CUTUCIRCUITS_URL: url,
      },
      stderr: "pipe",
    });
    const call = async <T>(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, JSON.stringify(result.content));
      const content = result.content as Array<{ type: string; text?: string }>;
      assert.equal(content[0].type, "text");
      return JSON.parse(content[0].text!) as T;
    };
    let projectId = "";
    try {
      await client.connect(transport);
      assert(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "project_environment",
        ),
      );
      const project = await call<Project>("create_project", {
        name: "Integrated sensor",
        template: "sensor",
      });
      projectId = project.id;
      const environment = await call<{ projectRoot: string }>(
        "project_environment",
        { projectId },
      );
      assert.equal(environment.projectRoot, path.join(dataDir, projectId));
      const files = await call<string[]>("list_files", { projectId });
      assert(files.includes("circuit.circuit.tsx"));
      const initial = await call<FileSnapshot>("read_file", {
        projectId,
        path: "circuit.circuit.tsx",
      });
      const changed = await call<FileSnapshot>("write_file", {
        projectId,
        path: initial.path,
        content: initial.content + "\n// Edited through Codex MCP.\n",
        expectedSha256: initial.sha256,
      });
      assert.notEqual(initial.sha256, changed.sha256);
      assert.match(
        await readFile(
          path.join(environment.projectRoot, initial.path),
          "utf8",
        ),
        /Edited through Codex MCP/,
      );
      const stale = await client.callTool({
        name: "write_file",
        arguments: {
          projectId,
          path: initial.path,
          content: "lost update",
          expectedSha256: initial.sha256,
        },
      });
      assert(stale.isError);
      assert.match(JSON.stringify(stale.content), /HASH_CONFLICT/);
      await call("set_selection", {
        projectId,
        entityId: "status-led",
        assetId: "circuit",
      });
      const visible = await fetch(
        `${url}/api/projects/${projectId}/selection`,
      ).then((response) => response.json());
      assert.equal(visible.entityId, "status-led");
      assert.equal(visible.origin, "codex");
      const circuit = await call<CircuitResult>("compile", {
        projectId,
        path: initial.path,
      });
      assert(circuit.components.some((component) => component.name === "LED1"));
      assert.match(circuit.schematicSvg, /<svg/);
      const cad = await call<CadResult>("compile", {
        projectId,
        path: "model.replicad.ts",
      });
      assert(cad.metrics.volume > 0);
      assert(cad.shapes.length > 0);
      const step = await call<{ content: string }>("export", {
        projectId,
        path: "model.replicad.ts",
        format: "step",
      });
      assert.match(step.content, /ISO-10303-21/);
      const started = await call<Operation>("run_operation", {
        projectId,
        capabilityId: "inspect",
        inputs: {},
      });
      let operation = started;
      for (
        let attempt = 0;
        attempt < 100 && operation.status === "running";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        operation = (
          await call<Operation[]>("list_operations", { projectId })
        ).find((value) => value.id === started.id)!;
      }
      assert.equal(
        operation.status,
        "succeeded",
        operation.error ?? operation.output,
      );
      assert.match(operation.output, /project-files/);
      // Terminal edits use the same files; polling must announce them and retain data.
      const event = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error("External edit event missing"));
        }, 5000);
        const off = runtime.store.events.subscribe(projectId, (value) => {
          if (value.type === "file.updated") {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      });
      await writeFile(
        path.join(environment.projectRoot, initial.path),
        changed.content + "// Edited from terminal.\n",
      );
      await event;
      assert.match(
        (
          await call<FileSnapshot>("read_file", {
            projectId,
            path: initial.path,
          })
        ).content,
        /Edited from terminal/,
      );
    } finally {
      await client.close();
      await runtime.close();
    }
    try {
      const reopened = await createRuntime({
        dataDir,
        seed: false,
        pollIntervalMs: 0,
      });
      try {
        assert.equal(
          (await reopened.store.get(projectId)).name,
          "Integrated sensor",
        );
        assert.match(
          (await reopened.store.read(projectId, "circuit.circuit.tsx")).content,
          /Edited from terminal/,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
