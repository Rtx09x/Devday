import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, SettingsSelect } from "@cutucircuits/ui";
import { diffLines } from "diff";
import type {
  FileHistoryEntry,
  FileHistoryVersion,
  FileSnapshot,
  Project,
} from "@cutucircuits/core";
import { api, ApiError } from "./api";

const reasons: Record<FileHistoryEntry["reason"], string> = {
  baseline: "Original version",
  save: "Saved",
  external: "Changed outside workspace",
  restore: "Restored",
  recovery: "Recovered",
};
function timestamp(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
async function currentFile(base: string, path: string) {
  try {
    return await api<FileSnapshot>(
      `${base}/files?path=${encodeURIComponent(path)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** History is scoped to saved native files. Drafts remain in their owning editors. */
export function HistoryPanel({
  project,
  initialPath,
  open,
  onOpenChange,
  onOpenChangeComplete,
  blocked,
  revision,
  onRestored,
}: {
  project: Project;
  initialPath?: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onOpenChangeComplete: (value: boolean) => void;
  blocked: boolean;
  revision: number;
  onRestored: (snapshot: FileSnapshot) => void;
}) {
  const [path, setPath] = useState(
    initialPath ?? project.assets[0]?.path ?? "",
  );
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [version, setVersion] = useState<FileHistoryVersion>();
  const [observed, setObserved] = useState<FileSnapshot | null>();
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [previewMode, setPreviewMode] = useState<"changes" | "saved">(
    "changes",
  );
  const request = useRef(0);
  const restoreScope = useRef(0);
  const base = `/projects/${project.id}`;
  useEffect(() => {
    restoreScope.current++;
    setRestoring(false);
    return () => {
      restoreScope.current++;
    };
  }, [open, path, base]);
  useEffect(() => {
    if (open && initialPath) setPath(initialPath);
  }, [open, initialPath]);
  useEffect(() => {
    const scope = ++request.current;
    if (!open || !path) return;
    setLoading(true);
    setError("");
    setConfirming(false);
    setObserved(undefined);
    Promise.all([
      api<FileHistoryEntry[]>(
        `${base}/history?path=${encodeURIComponent(path)}&limit=100`,
      ),
      currentFile(base, path),
    ])
      .then(([history, snapshot]) => {
        if (scope !== request.current) return;
        setEntries(history);
        setObserved(snapshot);
        setSelectedId((id) =>
          history.some((entry) => entry.id === id) ? id : "",
        );
      })
      .catch((error: unknown) => {
        if (scope === request.current)
          setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (scope === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [open, path, base, refresh, revision]);
  useEffect(() => {
    let cancelled = false;
    setVersion(undefined);
    setConfirming(false);
    if (!open || !selectedId || !path) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    api<FileHistoryVersion>(`${base}/history/${encodeURIComponent(selectedId)}`)
      .then((result) => {
        if (!cancelled && result.entry.path === path) setVersion(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId, path, base]);
  const changes = useMemo(
    () =>
      version && observed !== undefined
        ? diffLines(version.content, observed?.content ?? "", { timeout: 250 })
        : undefined,
    [version, observed],
  );
  const previewChanges =
    changes &&
    changes.reduce((count, change) => count + (change.count ?? 0), 0) <= 2000
      ? changes
      : undefined;
  const same =
    !!version &&
    version.entry.path === path &&
    version.content === observed?.content;
  const canRestore =
    !!version &&
    version.entry.path === path &&
    observed !== undefined &&
    !same &&
    !blocked &&
    !loading &&
    !restoring;
  async function restore() {
    if (!canRestore || !version) return;
    const scope = restoreScope.current;
    setRestoring(true);
    setError("");
    try {
      const snapshot = await api<FileSnapshot>(
        `${base}/history/${encodeURIComponent(version.entry.id)}/restore`,
        { expectedSha256: observed?.sha256 ?? null },
      );
      if (scope !== restoreScope.current) return;
      setObserved(snapshot);
      setConfirming(false);
      setMessage(
        "Version restored. The previous saved file remains in history.",
      );
      onRestored(snapshot);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (scope !== restoreScope.current) return;
      setConfirming(false);
      if (error instanceof ApiError && error.status === 409) {
        setMessage(
          "The file changed since this preview. Review the refreshed comparison before restoring.",
        );
        setRefresh((value) => value + 1);
      } else setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (scope === restoreScope.current) setRestoring(false);
    }
  }
  function choosePath(value: string) {
    setEntries([]);
    setSelectedId("");
    setMessage("");
    setError("");
    setPath(value);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      title="Version history"
      className="workspace-dialog history-dialog"
      containerClassName="history-dialog-container"
    >
      <div className="history-content">
        <p className="history-intro">
          Saved versions of your native files. Select a version to compare it
          with the file saved on this device.
        </p>
        {project.assets.length ? (
          <SettingsSelect
            aria-label="File history"
            value={path}
            onValueChange={choosePath}
            disabled={restoring}
            options={project.assets.map((asset) => ({
              value: asset.path,
              label: asset.name,
            }))}
          />
        ) : (
          <p className="quiet-note">This project has no native files yet.</p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="history-message" role="status">
            {message}
          </p>
        )}
        <div className="history-layout">
          <div
            className="history-list"
            aria-label="Saved versions"
            aria-busy={loading}
          >
            <div className="history-list-heading">
              <span>Saved versions</span>
              <Button
                size="sm"
                disabled={loading || restoring || !path}
                onClick={() => setRefresh((value) => value + 1)}
              >
                Refresh
              </Button>
            </div>
            {loading ? (
              <p className="quiet-note">Loading versions…</p>
            ) : entries.length ? (
              entries.map((entry) => (
                <Button
                  key={entry.id}
                  className="history-entry"
                  aria-pressed={selectedId === entry.id}
                  disabled={restoring}
                  onClick={() => {
                    setSelectedId(entry.id);
                      setError("");
                    setMessage("");
                    setPreviewMode("changes");
                  }}
                >
                  <strong>{reasons[entry.reason]}</strong>
                  <time dateTime={entry.createdAt}>
                    {timestamp(entry.createdAt)}
                  </time>
                  <small>
                    {new Intl.NumberFormat().format(entry.sizeBytes)} bytes
                    {entry.sha256 === observed?.sha256
                      ? " · Current saved file"
                      : ""}
                  </small>
                </Button>
              ))
            ) : (
              <p className="quiet-note">
                No saved versions yet. The original file is retained when you
                first save a change.
              </p>
            )}
            {!loading && entries.length === 100 && (
              <p className="quiet-note">Showing the latest 100 versions.</p>
            )}
          </div>
          <section
            className="history-preview"
            aria-label="Version comparison"
            aria-busy={previewing || loading}
          >
            {previewing ? (
              <p className="quiet-note">Loading preview…</p>
            ) : version && observed !== undefined ? (
              <>
                <div className="history-preview-heading">
                  <strong>{timestamp(version.entry.createdAt)}</strong>
                  <span>
                    {same
                      ? "Matches the current saved file"
                      : observed === null
                        ? "The current file is missing"
                        : "Compared with the current saved file"}
                  </span>
                </div>
                <div
                  className="history-preview-tabs"
                  role="tablist"
                  aria-label="Version preview"
                >
                  <Button
                    role="tab"
                    aria-selected={previewMode === "changes"}
                    onClick={() => setPreviewMode("changes")}
                  >
                    Changes
                  </Button>
                  <Button
                    role="tab"
                    aria-selected={previewMode === "saved"}
                    onClick={() => setPreviewMode("saved")}
                  >
                    Saved version
                  </Button>
                </div>
                {previewMode === "saved" ? (
                  <pre
                    className="history-code"
                    tabIndex={0}
                    aria-label="Saved version content"
                  >
                    {version.content || "Empty file"}
                  </pre>
                ) : (
                  <>
                    <p className="history-legend">
                      <span>− Selected version</span>
                      <span>+ Current saved file</span>
                    </p>
                    {same ? (
                      <p className="quiet-note">
                        No changes between these versions.
                      </p>
                    ) : previewChanges ? (
                      <pre
                        className="history-code"
                        tabIndex={0}
                        aria-label="Changes from selected version to current file"
                      >
                        {previewChanges.map((change, index) => (
                          <span
                            key={index}
                            className={
                              change.added
                                ? "history-added"
                                : change.removed
                                  ? "history-removed"
                                  : "history-context"
                            }
                          >
                            {change.value
                              .split(/(?<=\n)/)
                              .map((line, lineIndex) => (
                                <span className="history-line" key={lineIndex}>
                                  <span aria-hidden="true">
                                    {change.added
                                      ? "+ "
                                      : change.removed
                                        ? "− "
                                        : "  "}
                                  </span>
                                  {line.replace(/\n$/, "")}
                                </span>
                              ))}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <p className="quiet-note">
                        This comparison is too large. Open Saved version to
                        inspect the complete file.
                      </p>
                    )}
                  </>
                )}
                <div className="history-restore">
                  {blocked ? (
                    <p>
                      Save or discard your editor changes before restoring. Your
                      draft is preserved.
                    </p>
                  ) : (
                    <p>
                      Restoring replaces this saved file and keeps its current
                      version in history.
                    </p>
                  )}
                  {confirming && canRestore ? (
                    <div className="history-confirm">
                      <span>
                        Replace {path.split("/").at(-1)} with this version?
                      </span>
                      <div>
                        <Button size="sm" onClick={() => setConfirming(false)}>
                          Cancel
                        </Button>
                        <Button
                          variant="filled"
                          className="control-button accent"
                          onClick={() => void restore()}
                        >
                          Confirm restore
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="filled"
                      className="control-button accent"
                      disabled={!canRestore}
                      onClick={() => setConfirming(true)}
                    >
                      {restoring
                        ? "Restoring…"
                        : same
                          ? "Already current"
                          : "Restore this version"}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="history-placeholder">
                <strong>Choose a saved version</strong>
                <p>Preview its contents and changes before restoring a file.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </Dialog>
  );
}
