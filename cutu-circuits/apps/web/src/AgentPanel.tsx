import { useEffect, useRef, useState } from "react";
import { Button, Icon, IconButton, Menu, MenuItem } from "@cutucircuits/ui";
import { api } from "./api";
import { readAgentEvents } from "./agentStream";
import { AgentMarkdown } from "./AgentMarkdown";
import "./agent.css";

interface Approval {
  approvalId: string;
  callId: string;
  name: string;
  args: unknown;
  expiresAt: string;
  turnId: string;
  warning?: string;
}
interface Message {
  role: "user" | "assistant";
  content: string;
  turnId: string;
  images?: Attachment[];
}
interface Attachment {
  name: string;
  dataUrl: string;
}
interface Source {
  id: string;
  url: string;
  title: string;
}
interface Status {
  configured: boolean;
  searchConfigured: boolean;
  model: string;
  activeTurnId?: string;
  history: Message[];
  pendingApproval?: Approval | null;
  tools: {
    name: string;
    description: string;
    policy: "read" | "approval" | "denied";
  }[];
}
interface Activity {
  callId: string;
  name: string;
  args: unknown;
  result?: unknown;
  done: boolean;
}
const describe = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
const humanName = (name: string) => name.replaceAll("_", " ");

export function AgentPanel({
  projectId,
  projectName,
  onCodex,
}: {
  projectId?: string;
  projectName?: string;
  onCodex: () => void;
}) {
  const base = `/projects/${projectId}/agent`;
  const [status, setStatus] = useState<Status>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [deciding, setDeciding] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [addingImages, setAddingImages] = useState(false);
  const [settings, setSettings] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const owned = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const answerBuffer = useRef("");
  const frame = useRef<number | null>(null);
  const flushAnswer = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setAnswer(answerBuffer.current);
  };
  useEffect(() => {
    const current = ++generation.current;
    setStatus(undefined);
    setMessages([]);
    setAnswer("");
    setActivities([]);
    setSources([]);
    setApproval(null);
    setError("");
    setBusy(false);
    setDraft("");
    setDeciding(false);
    setAttachments([]);
    setAddingImages(false);
    setSettings(false);
    answerBuffer.current = "";
    if (projectId)
      void api<Status>(base + "/status")
        .then((next) => {
          if (current !== generation.current) return;
          setStatus(next);
          setMessages(next.history);
          setApproval(next.pendingApproval ?? null);
          if (next.activeTurnId)
            setError(
              "An assistant turn is already running for this project. You can stop it below.",
            );
        })
        .catch((e) => {
          if (current === generation.current) setError(e.message);
        });
    return () => {
      generation.current++;
      owned.current?.abort();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [projectId]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [messages, answer, activities, approval]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;
  }, [draft]);
  async function addImages(files: FileList | File[]) {
    const current = generation.current;
    const selected = Array.from(files);
    if (!selected.length || busy || addingImages) return;
    setAddingImages(true);
    try {
      if (selected.length + attachments.length > 2)
        throw new Error("Attach up to two images per message.");
      if (
        selected.some(
          (file) => !["image/png", "image/jpeg"].includes(file.type),
        )
      )
        throw new Error("Choose PNG or JPEG images.");
      const existingBytes = attachments.reduce(
        (total, item) =>
          total +
          Math.floor(((item.dataUrl.split(",")[1]?.length ?? 0) * 3) / 4),
        0,
      );
      if (
        existingBytes + selected.reduce((total, file) => total + file.size, 0) >
        3 * 1024 * 1024
      )
        throw new Error("Images must total 3 MB or less.");
      const images = await Promise.all(
        selected.map(
          (file) =>
            new Promise<Attachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({ name: file.name, dataUrl: String(reader.result) });
              reader.onerror = () =>
                reject(new Error("Could not read this image."));
              reader.readAsDataURL(file);
            }),
        ),
      );
      if (current === generation.current) {
        setAttachments((items) => [...items, ...images]);
        setError("");
        input.current?.focus();
      }
    } catch (error) {
      if (current === generation.current)
        setError(
          error instanceof Error ? error.message : "Could not attach image.",
        );
    } finally {
      if (current === generation.current) setAddingImages(false);
    }
  }
  async function send() {
    if (
      !projectId ||
      !draft.trim() ||
      busy ||
      addingImages ||
      !status?.configured ||
      status.activeTurnId
    )
      return;
    const message = draft.trim(),
      current = generation.current;
    const controller = new AbortController();
    owned.current = controller;
    setBusy(true);
    setError("");
    setApproval(null);
    setActivities([]);
    setSources([]);
    setAnswer("");
    answerBuffer.current = "";
    let terminal = false,
      turnId = "";
    try {
      const response = await fetch("/api" + base + "/turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(attachments.length ? { attachments } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error?.message ?? "Assistant request failed");
      }
      if (!response.body) throw new Error("Assistant stream is unavailable");
      if (current !== generation.current) return;
      setDraft("");
      setAttachments([]);
      setMessages((items) => [
        ...items,
        {
          role: "user",
          content: message,
          turnId: "pending",
          images: attachments,
        },
      ]);
      for await (const event of readAgentEvents(
        response.body,
        controller.signal,
      )) {
        if (current !== generation.current) return;
        turnId = event.turnId;
        if (event.type === "text_reset") {
          answerBuffer.current = "";
          flushAnswer();
        } else if (
          event.type === "text_delta" &&
          typeof event.delta === "string"
        ) {
          answerBuffer.current += event.delta;
          if (frame.current === null)
            frame.current = requestAnimationFrame(() => {
              frame.current = null;
              setAnswer(answerBuffer.current);
            });
        } else if (event.type === "tool_start") {
          setActivities((items) => [
            ...items,
            {
              callId: String(event.callId),
              name: String(event.name),
              args: event.args,
              done: false,
            },
          ]);
        } else if (event.type === "tool_result") {
          setActivities((items) =>
            items.map((item) =>
              item.callId === event.callId
                ? { ...item, done: true, result: event.result }
                : item,
            ),
          );
        } else if (event.type === "approval_required") {
          setApproval(event as unknown as Approval);
        } else if (event.type === "citations" && Array.isArray(event.sources)) {
          setSources(
            event.sources.filter(
              (source): source is Source =>
                !!source &&
                typeof source === "object" &&
                typeof source.id === "string" &&
                typeof source.url === "string" &&
                typeof source.title === "string" &&
                /^https?:\/\//i.test(source.url),
            ),
          );
        } else if (event.type === "complete") {
          terminal = true;
          if (typeof event.text === "string") answerBuffer.current = event.text;
          flushAnswer();
          const completedText = answerBuffer.current;
          if (completedText)
            setMessages((items) => [
              ...items,
              { role: "assistant", content: completedText, turnId },
            ]);
          setAnswer("");
          answerBuffer.current = "";
        } else if (event.type === "error" || event.type === "cancelled") {
          terminal = true;
          if (event.discardText) answerBuffer.current = "";
          flushAnswer();
          setError(
            event.type === "cancelled"
              ? "Assistant stopped. Completed tool actions are retained."
              : typeof event.message === "string"
                ? event.message
                : "The assistant could not finish this turn.",
          );
        }
      }
      if (!terminal)
        throw new Error(
          "Assistant connection ended before the turn finished. Review completed tool activity before retrying.",
        );
    } catch (e) {
      if (current === generation.current) {
        answerBuffer.current = "";
        flushAnswer();
        setError(
          controller.signal.aborted
            ? "Assistant stopped. Completed tool actions are retained."
            : e instanceof Error
              ? e.message
              : "Assistant failed",
        );
      }
    } finally {
      if (current === generation.current) {
        setBusy(false);
        setApproval(null);
        owned.current = undefined;
        void api<Status>(base + "/status")
          .then((next) => {
            if (current === generation.current) setStatus(next);
          })
          .catch(() => {});
      }
    }
  }
  async function decide(approved: boolean) {
    if (!approval || deciding) return;
    const current = generation.current;
    setDeciding(true);
    try {
      await api(
        base + `/approvals/${encodeURIComponent(approval.approvalId)}`,
        { approved },
      );
      if (current === generation.current) setApproval(null);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      if (current === generation.current) setDeciding(false);
    }
  }
  async function stop() {
    const current = generation.current;
    owned.current?.abort();
    try {
      await api(base + "/cancel", {});
      if (current === generation.current) {
        setApproval(null);
        setStatus((next) =>
          next ? { ...next, activeTurnId: undefined } : next,
        );
      }
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "Could not stop assistant");
    }
  }
  async function clear() {
    const current = generation.current;
    try {
      await api(base + "/history", {}, "DELETE");
      if (current === generation.current) {
        setMessages([]);
        setAnswer("");
        setActivities([]);
        setSources([]);
        setError("");
      }
    } catch (e) {
      if (current === generation.current)
        setError(
          e instanceof Error ? e.message : "Could not clear conversation",
        );
    }
  }
  if (!projectId)
    return (
      <div className="agent-empty">Open a project to start a conversation.</div>
    );
  const running = busy || !!status?.activeTurnId;
  const approvalArgs =
    approval?.args && typeof approval.args === "object"
      ? (approval.args as Record<string, unknown>)
      : null;
  return (
    <section className="workspace-agent" aria-label="Cutu workspace agent">
      <div className="agent-context">
        <span
          className={`agent-status-dot ${status?.configured ? "connected" : ""}`}
        />
        <span>{status?.configured ? "Qwen 3.8" : "Not connected"}</span>
        <span className="agent-context-project" title={projectName}>
          {projectName}
        </span>
        <Menu
          triggerLabel="Agent settings"
          trigger={(props) => (
            <IconButton {...props} label="Agent settings" size="sm">
              <Icon name="more-horizontal" size="sm" />
            </IconButton>
          )}
        >
          <MenuItem onClick={() => setSettings((value) => !value)}>
            Connections & permissions
          </MenuItem>
          <MenuItem onClick={onCodex} icon={<Icon name="codex" size="sm" />}>
            Connect Codex for larger tasks
          </MenuItem>
          <MenuItem
            disabled={running || !messages.length}
            onClick={() => void clear()}
            icon={<Icon name="trash" size="sm" />}
          >
            Clear conversation
          </MenuItem>
        </Menu>
      </div>
      {settings && (
        <div className="agent-settings">
          <strong>Connections</strong>
          <p>
            Cerebras {status?.configured ? "connected" : "not configured"} · Exa{" "}
            {status?.searchConfigured ? "connected" : "not configured"}
          </p>
          <p>
            Add <code>CEREBRAS_API_KEY</code> and <code>EXA_API_KEY</code> to
            the root <code>.env.local</code>, then restart with{" "}
            <code>Start-Workspace.ps1</code>. Keys stay on the server.
          </p>
          <details>
            <summary>Project tools & permissions</summary>
            <p>Changes, code execution and hardware actions need approval.</p>
            {status?.tools.map((tool) => (
              <p key={tool.name}>
                {humanName(tool.name)} ·{" "}
                {tool.policy === "approval"
                  ? "approval required"
                  : tool.policy === "denied"
                    ? "external Codex only"
                    : "read / inspect"}
              </p>
            ))}
          </details>
        </div>
      )}
      <div
        className="agent-transcript"
        ref={scroll}
        aria-label="Agent conversation"
      >
        {!messages.length && !answer && (
          <div className="agent-empty">
            <span className="agent-empty-mark">
              <Icon name="bolt" size="lg" />
            </span>
            <h3>What are we building?</h3>
            <p>
              Ask about the design, research a component, or work through a
              change.
            </p>
            {!status?.configured && status && (
              <div className="agent-config" role="status">
                <strong>Connect Cerebras to get started</strong>
                <button type="button" onClick={() => setSettings(true)}>
                  Connection settings <Icon name="arrow-right" size="xs" />
                </button>
              </div>
            )}
            <div className="agent-suggestions">
              <Button
                onClick={() => {
                  setDraft(
                    "Inspect this project's controller and servo wiring. Check D5, D6, D7 and explain what you can verify before proposing any changes.",
                  );
                  input.current?.focus();
                }}
              >
                <Icon name="code" size="sm" />
                Review the wiring
              </Button>
              <Button
                onClick={() => {
                  setDraft(
                    "Find manufacturer sources for this project's controller, compare them with the project assumptions, and cite the sources. Ask before changing the project.",
                  );
                  input.current?.focus();
                }}
              >
                <Icon name="search" size="sm" />
                Research a component
              </Button>
            </div>
          </div>
        )}
        {messages.map((item, i) => (
          <article
            className={`agent-message ${item.role}`}
            key={`${item.turnId}-${i}`}
          >
            <span className="agent-message-author">
              {item.role === "user" ? "You" : "Cutu"}
            </span>
            {item.images?.length ? (
              <div className="agent-message-images">
                {item.images.map((image, index) => (
                  <img key={index} src={image.dataUrl} alt={image.name} />
                ))}
              </div>
            ) : null}
            {item.role === "assistant" ? (
              <AgentMarkdown text={item.content} />
            ) : (
              <div>{item.content}</div>
            )}
          </article>
        ))}
        {answer && (
          <article className="agent-message assistant">
            <span className="agent-message-author">Cutu</span>
            <AgentMarkdown text={answer} streaming={busy} />
          </article>
        )}
        {busy && !answer && !approval && (
          <div className="agent-working" role="status">
            <span className="agent-status-dot connected" />
            {activities.some((item) => !item.done)
              ? "Working on the project…"
              : "Thinking…"}
          </div>
        )}
        {activities.length > 0 && (
          <details className="agent-activity" aria-label="Agent tool activity">
            <summary>
              {activities.length} tool{" "}
              {activities.length === 1 ? "action" : "actions"}
              {activities.some((item) => !item.done) && busy
                ? " · working"
                : " · finished"}
            </summary>
            {activities.map((item) => (
              <details key={item.callId}>
                <summary>
                  {item.done ? "✓" : "…"} {humanName(item.name)}
                </summary>
                <pre>{describe(item.args)}</pre>
                {item.done && <pre>{describe(item.result)}</pre>}
              </details>
            ))}
          </details>
        )}
        {sources.length > 0 && (
          <details className="agent-sources" open>
            <summary>Sources · {sources.length}</summary>
            {sources.map((source) => (
              <a
                key={source.id}
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                {source.id} · {source.title || new URL(source.url).hostname}
                <Icon name="arrow-right" size="xs" />
              </a>
            ))}
          </details>
        )}
        {approval && (
          <div
            className="agent-approval"
            role="region"
            aria-label="Approve agent action"
          >
            <div className="agent-approval-heading">
              <Icon name="check" size="sm" />
              <strong>Review {humanName(approval.name)}</strong>
            </div>
            {approval.warning && (
              <p className="agent-action-warning">{approval.warning}</p>
            )}
            {typeof approvalArgs?.path === "string" && (
              <code className="agent-file-path">{approvalArgs.path}</code>
            )}
            {typeof approvalArgs?.content === "string" && (
              <pre className="agent-source-preview">{approvalArgs.content}</pre>
            )}
            <details>
              <summary>Exact action details</summary>
              <pre>{describe(approval.args)}</pre>
            </details>
            <p className="agent-approval-note">
              Applies only to this action in this project.
            </p>
            <div className="agent-approval-actions">
              <Button disabled={deciding} onClick={() => void decide(false)}>
                Reject
              </Button>
              <Button
                variant="filled"
                disabled={deciding}
                onClick={() => void decide(true)}
              >
                Approve action
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="agent-composer-wrap">
        <form
          className="agent-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              void addImages(event.dataTransfer.files);
            }
          }}
        >
          {attachments.length > 0 && (
            <div className="agent-attachments">
              {attachments.map((image, index) => (
                <div className="agent-attachment" key={index}>
                  <img src={image.dataUrl} alt={image.name} />
                  <IconButton
                    label={`Remove ${image.name}`}
                    disabled={busy}
                    size="sm"
                    onClick={() =>
                      setAttachments((items) =>
                        items.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Icon name="close" size="xs" />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          <label className="agent-sr-only" htmlFor="cutu-agent-message">
            Ask Cutu
          </label>
          <textarea
            ref={input}
            id="cutu-agent-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={16000}
            placeholder="Ask Cutu about your design…"
            disabled={running}
            rows={2}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (images.length) {
                event.preventDefault();
                void addImages(images);
              }
            }}
          />
          <div className="agent-composer-toolbar">
            <input
              className="agent-sr-only"
              ref={filePicker}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              aria-label="Attach images"
              tabIndex={-1}
              onChange={(event) => {
                if (event.target.files) void addImages(event.target.files);
                event.target.value = "";
              }}
            />
            <IconButton
              label="Attach images"
              title="Attach PNG or JPEG · 2 images, 3 MB total"
              disabled={running || addingImages || attachments.length >= 2}
              onClick={() => filePicker.current?.click()}
            >
              <Icon name="attachment" size="sm" />
            </IconButton>
            <span>
              {addingImages
                ? "Adding images…"
                : attachments.length
                  ? `${attachments.length}/2 images`
                  : "PNG / JPEG"}
            </span>
            {running ? (
              <IconButton
                className="agent-send"
                label="Stop"
                variant="filled"
                onClick={() => void stop()}
              >
                <Icon name="stop" size="sm" />
              </IconButton>
            ) : (
              <IconButton
                className="agent-send"
                label="Send"
                variant="filled"
                type="submit"
                disabled={!status?.configured || addingImages || !draft.trim()}
              >
                <Icon name="arrow-right" size="sm" />
              </IconButton>
            )}
          </div>
        </form>
        <div className="agent-composer-hint">
          {attachments.length
            ? "Images apply to this message only"
            : status?.searchConfigured
              ? "Web sources enabled"
              : "Project context"}
          <span>Enter to send · Shift + Enter for a new line</span>
        </div>
      </div>
    </section>
  );
}
