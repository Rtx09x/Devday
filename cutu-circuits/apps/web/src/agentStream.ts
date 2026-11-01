export interface WorkspaceAgentEvent {
  type: string;
  turnId: string;
  [key: string]: unknown;
}

/** POST streaming: decode framing independently of transport/UTF-8 chunk boundaries. */
export async function* readAgentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<WorkspaceAgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    eventName = "",
    data: string[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(part.value, { stream: !part.done });
      while (true) {
        const newline = /\r\n|\r|\n/.exec(buffer);
        if (
          !newline ||
          (newline[0] === "\r" &&
            newline.index === buffer.length - 1 &&
            !part.done)
        )
          break;
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline[0].length);
        if (!line) {
          if (data.length) {
            const value: unknown = JSON.parse(data.join("\n"));
            if (
              !value ||
              typeof value !== "object" ||
              !("turnId" in value) ||
              typeof value.turnId !== "string"
            )
              throw new Error("Invalid assistant event");
            yield {
              ...value,
              type:
                eventName ||
                ("type" in value && typeof value.type === "string"
                  ? value.type
                  : "message"),
            } as WorkspaceAgentEvent;
          }
          eventName = "";
          data = [];
        } else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
        if (data.reduce((n, item) => n + item.length, 0) > 2 * 1024 * 1024)
          throw new Error("Assistant event is too large");
      }
      if (buffer.length > 2 * 1024 * 1024)
        throw new Error("Assistant event is too large");
      if (part.done) break;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {
      /* Preserve the stream outcome. */
    }
    reader.releaseLock();
  }
}
