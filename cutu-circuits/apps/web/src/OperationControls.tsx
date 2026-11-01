import { useState } from "react";
import { Button } from "@cutucircuits/ui";
export function OperationControls({
  onSend,
}: {
  onSend: (message: Record<string, unknown>) => Promise<void>;
}) {
  const [content, setContent] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function send() {
    setError("");
    let message: unknown;
    try {
      message = JSON.parse(content);
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new Error("Enter a JSON object.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      await onSend(message as Record<string, unknown>);
      setContent("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="operation-controls">
      <label>
        Program message
        <textarea
          aria-label="Program message"
          placeholder="JSON message accepted by this program"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
        />
      </label>
      <Button
        className="control-button"
        onClick={() => void send()}
        disabled={!content.trim() || busy}
      >
        {busy ? "Sending…" : "Send message"}
      </Button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
