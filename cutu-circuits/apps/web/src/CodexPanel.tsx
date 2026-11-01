import { useState } from "react";
import { Button } from "@cutucircuits/ui";
import { Glyph } from "./Glyph";
export function CodexPanel({ projectId }: { projectId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codex-info">
      <span className="codex-logo">
        <Glyph name="code" />
      </span>
      <h3>Build with Codex</h3>
      <p>
        Explore the design, edit native files and run project actions from
        Codex. Saved changes and selections appear in this workspace.
      </p>
      <div className="connection-status">
        <span className="status-dot neutral" />
        <span>Plugin setup required</span>
      </div>
      <ol className="connection-steps">
        <li>
          <strong>Open your project in Codex</strong>
          <p>Use the Cutu Circuits repository on this device.</p>
        </li>
        <li>
          <strong>Install the local plugin</strong>
          <p>
            Add this repository as a local plugin marketplace, then install Cutu
            Circuits in the plugin browser.
          </p>
        </li>
        <li>
          <strong>Start a conversation</strong>
          <p>
            Ask Codex to inspect your projects. The plugin uses the same local
            runtime as this workspace.
          </p>
        </li>
      </ol>
      {projectId && (
        <Button
          variant="filled"
          className="control-button copy-context"
          onClick={async () => {
            await navigator.clipboard.writeText(
              `Use the Cutu Circuits plugin to inspect project ${projectId}. Read the project and current selection before making changes.`,
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          }}
        >
          <Glyph name={copied ? "save" : "code"} />
          {copied ? "Project context copied" : "Copy project context"}
        </Button>
      )}
      <details className="technical-details">
        <summary>Connection details</summary>
        <p>Run this in the repository, using its absolute path:</p>
        <code>
          codex plugin marketplace add /absolute/path/to/cutu-circuits
        </code>
        <p>
          In a new Codex conversation, call{" "}
          <code className="inline-code">runtime_status</code> and{" "}
          <code className="inline-code">list_projects</code> to verify access.
        </p>
        <dl className="connection-facts">
          <dt>Project</dt>
          <dd>{projectId ?? "None selected"}</dd>
          <dt>Runtime</dt>
          <dd>127.0.0.1:4310</dd>
        </dl>
        <p>This panel cannot verify or host a Codex session.</p>
      </details>
    </div>
  );
}
