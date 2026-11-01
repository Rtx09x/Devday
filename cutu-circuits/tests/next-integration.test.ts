import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRuntime } from "../packages/runtime/src/server.ts";
import type {
  FileSnapshot,
  FileHistoryEntry,
  FileHistoryVersion,
  Project,
} from "@cutucircuits/core";

test(
  "packaged Codex tools import, inspect, simulate and restore a real persisted URDF",
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "cutu-robot-mcp-"));
    const runtime = await createRuntime({
      dataDir,
      seed: false,
      port: 0,
      pollIntervalMs: 0,
    });
    const server = await runtime.listen();
    const address = server.address();
    assert(address && typeof address === "object");
    const client = new Client({
      name: "cutucircuits-next-test",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("plugins/cutucircuits/scripts/launch.mjs")],
      cwd: tmpdir(),
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        CUTUCIRCUITS_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    async function call<T>(
      name: string,
      args: Record<string, unknown>,
    ): Promise<T> {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, JSON.stringify(result.content));
      const content = result.content as Array<{ type: string; text?: string }>;
      assert.equal(content[0].type, "text");
      return JSON.parse(content[0].text!);
    }
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      assert.equal(catalog.tools.length, 27);
      for (const name of [
        "list_file_history",
        "read_file_version",
        "restore_file_version",
        "import_urdf",
        "inspect_robot",
        "simulate_robot",
      ])
        assert(catalog.tools.some((tool) => tool.name === name));
      const p = await call<Project>("create_project", {
        name: "Codex physics",
        template: "robot",
      });
      const xml = await readFile(
        path.resolve("examples/robot/arm.urdf"),
        "utf8",
      );
      const imported = await call<{
        asset: { id: string };
        file: FileSnapshot;
      }>("import_urdf", {
        projectId: p.id,
        path: "models/imported.urdf",
        content: xml,
      });
      const observed = await call<FileSnapshot>("read_file", {
        projectId: p.id,
        path: imported.file.path,
      });
      assert.equal(observed.content, xml);
      const edited = await call<FileSnapshot>("write_file", {
        projectId: p.id,
        path: observed.path,
        content: xml + "\n<!-- Authored through Codex -->\n",
        expectedSha256: observed.sha256,
      });
      const history = await call<FileHistoryEntry[]>("list_file_history", {
        projectId: p.id,
        path: observed.path,
      });
      const original = history.find(
        (version) => version.sha256 === observed.sha256,
      );
      assert(original);
      const version = await call<FileHistoryVersion>("read_file_version", {
        projectId: p.id,
        versionId: original.id,
      });
      assert.equal(version.content, xml);
      const restored = await call<FileSnapshot>("restore_file_version", {
        projectId: p.id,
        versionId: original.id,
        expectedSha256: edited.sha256,
      });
      assert.equal(restored.content, xml);
      const stale = await client.callTool({
        name: "restore_file_version",
        arguments: {
          projectId: p.id,
          versionId: original.id,
          expectedSha256: edited.sha256,
        },
      });
      assert(stale.isError);
      assert.match(JSON.stringify(stale.content), /HASH_CONFLICT/);
      const inspected = await call<any>("inspect_robot", {
        projectId: p.id,
        path: observed.path,
      });
      assert.equal(inspected.model.links.length, 3);
      const simulation = await call<any>("simulate_robot", {
        projectId: p.id,
        path: observed.path,
        durationSeconds: 0.5,
        fixedBase: true,
        jointTargets: { shoulder: 0.4 },
      });
      assert.equal(simulation.source, "simulated");
      assert(simulation.final.time >= 0.49);
      assert(simulation.final.joints.shoulder.position > 0.1);
      assert.equal(
        await readFile(path.join(dataDir, p.id, observed.path), "utf8"),
        xml,
      );
    } finally {
      await client.close();
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

