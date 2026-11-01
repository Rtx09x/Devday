import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton, Tooltip } from "@cutucircuits/ui";
import type {
  Project,
  FileSnapshot,
  EngineResult,
  Operation,
  Capability,
  ArtifactResult,
} from "@cutucircuits/core";
import { api, ApiError, download } from "./api";
import { EditorBoundary } from "./EditorBoundary";
import { EntityInspector } from "./EntityInspector";
import { RobotWalkControls } from "./RobotWalkControls";
import { AssemblyReplay } from "./AssemblyReplay";
import { SourceEditor } from "./SourceEditor";
import { useRestoringDialog } from "./useRestoringDialog";
import { useProjectSession } from "./useProjectSession";
import { useAssemblyCad } from "./useAssemblyCad";
import { programMotion } from "./programMotion";
import { Scene } from "./Scene";
import { Glyph } from "./Glyph";
import { CodexPanel } from "./CodexPanel";
import { AgentPanel } from "./AgentPanel";
import { applyTheme, useColorMode } from "./theme";
import { CapabilitiesPanel } from "./CapabilitiesPanel";
import { ProjectSidebar, type View } from "./ProjectSidebar";
import { ViewToolbar } from "./ViewToolbar";
import { artifactLabel } from "./ProjectSidebar";
import { CreateProjectDialog, ToolPalette } from "./WorkspaceDialogs";
import { HistoryPanel } from "./HistoryPanel";
const CircuitEditor = lazy(() => import("@cutucircuits/electronics-editor"));
const CadEditor = lazy(() => import("@cutucircuits/cad-editor"));
const RobotWorkspace = lazy(() => import("./robotics/RobotWorkspace"));
const RobotImportDialog = lazy(() => import("./robotics/RobotImportDialog"));
export function App() {
  const colorMode = useColorMode();
  const [view, setView] = useState<View>("assembly"),
    [assetId, setAssetId] = useState(""),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 800),
    [panel, setPanel] = useState<"tools" | "codex" | "agent" | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [newName, setNewName] = useState(""),
    [template, setTemplate] = useState("blank"),
    [nativeDirty, setNativeDirty] = useState(false),
    [file, setFile] = useState<FileSnapshot>(),
    [content, setContent] = useState(""),
    [conflict, setConflict] = useState(false),
    [busy, setBusy] = useState(""),
    [compiled, setCompiled] = useState<EngineResult>(),
    [cadRevision, setCadRevision] = useState(0),
    [cadForceRevision, setCadForceRevision] = useState(0),
    [historyRevision, setHistoryRevision] = useState(0),
    [importingRobot, setImportingRobot] = useState(false),
    [capId, setCapId] = useState(""),
    [inputs, setInputs] = useState<Record<string, unknown>>({}),
    [suppressedOperationId, setSuppressedOperationId] = useState<string>(),
    [playing, setPlaying] = useState(false),
    [phase, setPhase] = useState(-1),
    [motionReset, setMotionReset] = useState(0),
    [replayStage, setReplayStage] = useState<number | null>(null),
    [buildRun, setBuildRun] = useState(0),
    [buildRequest, setBuildRequest] = useState<{
      projectId: string;
      requestId?: string;
      acknowledged?: boolean;
    }>(),
    [reset, setReset] = useState(0),
    [query, setQuery] = useState("");
  const [telemetryNow, setTelemetryNow] = useState(Date.now);
  const [creating, setCreating, restoreCreateFocus] = useRestoringDialog(
    '[aria-label="New project"], [aria-label="Workspace actions"]',
  );
  const [palette, setPalette, restorePaletteFocus] = useRestoringDialog(
    '.command-button, [aria-label="Toggle project navigation"]',
  );
  const [history, setHistory, restoreHistoryFocus] = useRestoringDialog(
    '[aria-label="Workspace actions"], .command-button',
  );
  useEffect(() => {
    const handler = (event: Event) =>
      setNotice(
        String((event as CustomEvent<{ message: string }>).detail.message),
      );
    window.addEventListener("cutucircuits:editor-notice", handler);
    return () =>
      window.removeEventListener("cutucircuits:editor-notice", handler);
  }, []);
  const projectEpoch = useRef(0);
  const activeEditor = useRef("");
  const dirty = !!file && content !== file.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const unsavedRef = useRef(dirty || nativeDirty);
  unsavedRef.current = dirty || nativeDirty;
  const fileRef = useRef(file);
  fileRef.current = file;
  const errorSource = useRef<"operation" | "sync" | null>(null);
  const fail = (e: unknown) => {
    errorSource.current = "operation";
    setError(e instanceof Error ? e.message : String(e));
  };
  const failSync = (e: unknown) => {
    errorSource.current = "sync";
    setError(e instanceof Error ? e.message : String(e));
  };
  const clearSyncError = () => {
    if (errorSource.current !== "sync") return;
    errorSource.current = null;
    setError("");
  };
  const {
    projects,
    project,
    selection,
    operations,
    setOperations,
    loading,
    loadProjects,
    openProject: loadProject,
    select,
  } = useProjectSession({
    onOpened: () => {
      projectEpoch.current++;
      setError("");
      setAssetId("");
      setFile(undefined);
      setContent("");
      setCompiled(undefined);
      setView("assembly");
      setPlaying(false);
      setReplayStage(null);
      setBuildRequest(undefined);
      setPhase(-1);
      setSuppressedOperationId(undefined);
      setPanel(null);
      setHistory(false);
      setImportingRobot(false);
      setCapId("");
      setInputs({});
      setNativeDirty(false);
      setConflict(false);
      setBusy("");
    },
    onError: failSync,
    onReconciled: clearSyncError,
    onFilesChanged: (change, current) => {
      setHistoryRevision((value) => value + 1);
      const cadPath = project?.assets.find((a) => a.kind === "cad")?.path;
      if (
        cadPath &&
        (!change || change.path === cadPath || change.paths?.includes(cadPath))
      )
        setCadRevision((value) => value + 1);
      const source = fileRef.current;
      if (
        !source ||
        !project ||
        (change &&
          change.path !== source.path &&
          !change.paths?.includes(source.path))
      )
        return;
      const path = source.path;
      api<FileSnapshot>(
        `/projects/${project.id}/files?path=${encodeURIComponent(path)}`,
      )
        .then((snapshot) => {
          if (!current() || fileRef.current?.path !== path) return;
          clearSyncError();
          if (snapshot.sha256 === fileRef.current.sha256) return;
          if (dirtyRef.current) setConflict(true);
          else {
            setFile(snapshot);
            setContent(snapshot.content);
            setConflict(false);
          }
        })
        .catch((e) => {
          if (current()) failSync(e);
        });
    },
  });
  const openProject = (id: string) => {
    if (operations.some(op => op.status === "running" && op.capabilityId === "walk")) {
      setError("Stop the robot before switching projects.");
      return Promise.resolve();
    }
    projectEpoch.current++;
    setReplayStage(null);
    setBuildRequest(undefined);
    setHistory(false);
    setImportingRobot(false);
    setError("");
    return loadProject(id);
  };
  const {
    cad: assemblyCad,
    loading: cadLoading,
    error: cadError,
  } = useAssemblyCad(project, cadRevision, cadForceRevision);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          dirty: boolean;
          projectId: string;
          path: string;
        }>
      ).detail;
      const editorAsset = project?.assets.find((a) => a.id === assetId);
      if (
        (view === "circuit" || view === "cad") &&
        detail.projectId === project?.id &&
        detail.path === editorAsset?.path
      )
        setNativeDirty(Boolean(detail.dirty));
    };
    window.addEventListener("cutucircuits:dirty", handler);
    return () => window.removeEventListener("cutucircuits:dirty", handler);
  }, [project?.id, assetId, view]);
  const selected = project?.entities.find((e) => e.id === selection?.entityId);
  const asset = project?.assets.find((a) => a.id === assetId);
  const capability = project?.hardware?.capabilities.find(
    (c) => c.id === capId,
  );
  const editorKey = `${project?.id ?? ""}:${assetId}:${view}`;
  activeEditor.current = editorKey;
  const base = project ? `/projects/${project.id}` : "";
  const safeLeave = () =>
    !(dirty || nativeDirty) ||
    window.confirm("Discard your unsaved source changes?");
  const changeView = (next: View) => {
    if (next === view) return;
    if (!safeLeave()) return;
    setNativeDirty(false);
    setView(next);
    setFile(undefined);
    setCompiled(undefined);
    if (next === "circuit" || next === "cad" || next === "robot") {
      const target = project?.assets.find(
        (a) => a.kind === (next === "robot" ? "urdf" : next),
      );
      setAssetId(target?.id ?? "");
    }
    if (next === "source" && !assetId) setAssetId(project?.assets[0]?.id ?? "");
  };
  const openAsset = (id: string, source = false) => {
    const target = project?.assets.find((item) => item.id === id);
    if (!target) return;
    const nextView: View = source
      ? "source"
      : target.kind === "circuit"
        ? "circuit"
        : target.kind === "cad"
          ? "cad"
          : target.kind === "urdf"
            ? "robot"
            : "source";
    if ((target.id === assetId && view === nextView) || !safeLeave()) return;
    setNativeDirty(false);
    setAssetId(target.id);
    setFile(undefined);
    setCompiled(undefined);
    setView(nextView);
  };
  const openRobotImport = () => {
    if (project && safeLeave()) setImportingRobot(true);
  };
  useEffect(() => {
    if (view !== "source" || !project || !asset) return;
    let cancelled = false;
    setBusy("Loading source");
    api<FileSnapshot>(`${base}/files?path=${encodeURIComponent(asset.path)}`)
      .then((s) => {
        if (!cancelled) {
          setFile(s);
          setContent(s.content);
          setConflict(false);
        }
      })
      .catch((e) => {
        if (!cancelled) failSync(e);
      })
      .finally(() => {
        if (!cancelled) setBusy("");
      });
    return () => {
      cancelled = true;
      setBusy((value) => (value === "Loading source" ? "" : value));
    };
  }, [view, assetId, project?.id]);
  const save = useCallback(async () => {
    if (!file || !project) return;
    const epoch = projectEpoch.current;
    const scope = activeEditor.current;
    const current = () =>
      epoch === projectEpoch.current && scope === activeEditor.current;
    setBusy("Saving");
    setError("");
    try {
      const snapshot = await api<FileSnapshot>(
        `/projects/${project.id}/files`,
        { path: file.path, content, expectedSha256: file.sha256 },
        "PUT",
      );
      if (!current()) return;
      setFile(snapshot);
      setConflict(false);
      setNotice("Source saved");
      setHistoryRevision((value) => value + 1);
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      fail(e);
    } finally {
      if (current()) setBusy("");
    }
  }, [file, content, project?.id]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirtyRef.current) void save();
      }
      if (e.key === "Escape") {
        setPalette(false);
        setPanel(null);
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      if (e.key === "f") setReset((v) => v + 1);
    };
    window.addEventListener("keydown", handler);
    const unload = (e: BeforeUnloadEvent) => {
      if (unsavedRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("beforeunload", unload);
    };
  }, [save]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  async function compile() {
    if (!asset) return;
    const epoch = projectEpoch.current;
    const scope = activeEditor.current;
    const current = () =>
      epoch === projectEpoch.current && scope === activeEditor.current;
    setBusy("Compiling");
    setError("");
    try {
      const result = await api<EngineResult>(`${base}/compile`, {
        path: asset.path,
        force: true,
      });
      if (!current()) return;
      setCompiled(result);
      setNotice("Compiled native source");
    } catch (e) {
      if (current()) fail(e);
    } finally {
      if (current()) setBusy("");
    }
  }
  async function exportAsset(format: string) {
    if (!asset) return;
    const epoch = projectEpoch.current;
    const current = () => epoch === projectEpoch.current;
    setBusy("Exporting");
    try {
      const artifact = await api<ArtifactResult>(`${base}/export`, {
        path: asset.path,
        format,
      });
      download(artifact.name, artifact.mimeType, artifact.content);
      if (current()) setNotice("Export downloaded");
    } catch (e) {
      if (current()) fail(e);
    } finally {
      if (current()) setBusy("");
    }
  }
  async function create() {
    if (!newName.trim() || !safeLeave()) return;
    setBusy("Creating");
    try {
      const p = await api<Project>("/projects", {
        name: newName.trim(),
        template,
      });
      await loadProjects();
      setCreating(false);
      setNewName("");
      await openProject(p.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  async function run() {
    if (!capability) return;
    const epoch = projectEpoch.current;
    const current = () => epoch === projectEpoch.current;
    setBusy("Starting");
    try {
      const op = await api<Operation>(`${base}/operations`, {
        capabilityId: capability.id,
        inputs,
      });
      if (!current()) return;
      setOperations((v) => [...v.filter((x) => x.id !== op.id), op]);
      setSuppressedOperationId(undefined);
      setPlaying(false);
      setPhase(-1);
    } catch (e) {
      if (current()) fail(e);
    } finally {
      if (current()) setBusy("");
    }
  }
  async function stopRobot(operation: Operation) {
    const epoch = projectEpoch.current;
    try {
      const stopped = await api<Operation>(`${base}/operations/${operation.id}/cancel`, {});
      if (epoch === projectEpoch.current)
        setOperations(items => items.map(item => item.id === stopped.id ? stopped : item));
    } catch (error) { if (epoch === projectEpoch.current) fail(error); }
  }
  async function walkForward(cycles: number) {
    if (!project || busy || !Number.isInteger(cycles) || cycles < 1 || cycles > 100) return;
    const epoch = projectEpoch.current;
    setBusy("Starting robot");
    try {
      const active = operations.find(op => op.status === "running");
      if (active) {
        if (active.capabilityId !== "connect") throw new Error("Stop the current robot action first.");
        const stopped = await api<Operation>(`${base}/operations/${active.id}/cancel`, {});
        if (epoch !== projectEpoch.current) return;
        setOperations(items => items.map(item => item.id === stopped.id ? stopped : item));
      }
      if (epoch !== projectEpoch.current) return;
      const op = await api<Operation>(`${base}/operations`, {
        capabilityId: "walk", inputs: { steps: cycles, speed: 100, durationSeconds: 180, telemetryHz: 2 },
      });
      if (epoch !== projectEpoch.current) return;
      setOperations(items => [...items.filter(item => item.id !== op.id), op]);
      setReplayStage(null);
      setBuildRequest(undefined);
      setPlaying(false);
      setPhase(-1);
      setSuppressedOperationId(undefined);
    } catch (error) { if (epoch === projectEpoch.current) fail(error); }
    finally { if (epoch === projectEpoch.current) setBusy(""); }
  }
  function chooseCapability(c: Capability) {
    setCapId(c.id);
    const schema = c.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    setInputs(
      Object.fromEntries(
        Object.entries(schema ?? {})
          .filter(([, s]) => s.default !== undefined)
          .map(([k, s]) => [k, s.default]),
      ),
    );
  }
  const deviceOperation = operations.find(
    (operation) =>
      operation.status === "running" &&
      operation.telemetry?.source === "device",
  );
  useEffect(() => {
    if (!deviceOperation) return;
    setTelemetryNow(Date.now());
    const refreshClock = () => setTelemetryNow(Date.now());
    document.addEventListener("visibilitychange", refreshClock);
    const timer = window.setInterval(() => setTelemetryNow(Date.now()), 200);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshClock);
    };
  }, [deviceOperation]);
  const availableProgram = programMotion(
    project?.motion,
    operations,
    undefined,
    telemetryNow,
  );
  useEffect(() => {
    if (!deviceOperation) return;
    setPlaying(false);
    setPhase(-1);
    setReplayStage(null);
    setSuppressedOperationId(undefined);
  }, [deviceOperation?.id]);
  useEffect(() => {
    if (operations.some((operation) => operation.status === "running"))
      setReplayStage(null);
  }, [operations]);
  useEffect(() => {
    setReplayStage(null);
    setPlaying(false);
  }, [project?.id, view, assemblyCad]);
  useEffect(() => {
    setBuildRequest((request) =>
      request?.projectId === project?.id && view === "assembly"
        ? request
        : undefined,
    );
  }, [project?.id, view]);
  const replayAvailable =
    !!project?.entities.some((entity) => entity.id === "servo-left") &&
    !!project?.entities.some((entity) => entity.id === "controller");
  const commandedProgram = programMotion(
    project?.motion,
    operations,
    suppressedOperationId,
    telemetryNow,
  );
  const manualMotion = () => {
    setReplayStage(null);
    if (availableProgram)
      setSuppressedOperationId(availableProgram.operationId);
  };
  const acknowledgeBuild = (
    request: { projectId: string; requestId?: string; acknowledged?: boolean },
    status: "started" | "queued" | "rejected" | "stopped",
  ) => {
    if (!request.requestId || request.acknowledged) return;
    void api(`/projects/${request.projectId}/presentation/ack`, {
      requestId: request.requestId,
      status,
    }).catch(failSync);
  };
  useEffect(() => {
    const trigger = (event: Event) => {
      const request = (
        event as CustomEvent<{
          projectId: string;
          requestId?: string;
          action?: "start" | "stop";
        }>
      ).detail;
      if (!request || request.projectId !== project?.id) return;
      if (request.action === "stop") {
        setBuildRequest(undefined);
        setReplayStage(null);
        acknowledgeBuild(request, "stopped");
        return;
      }
      // External presentation requests never discard or prompt over an editor draft.
      if (
        unsavedRef.current ||
        operations.some((operation) => operation.status === "running") ||
        !replayAvailable ||
        loading ||
        (!assemblyCad && cadError)
      ) {
        acknowledgeBuild(request, "rejected");
        return;
      }
      setView("assembly");
      const queued = !assemblyCad || cadLoading;
      setBuildRequest({ ...request, acknowledged: queued });
      if (queued) acknowledgeBuild(request, "queued");
    };
    window.addEventListener("cutu:build-makada", trigger);
    return () => window.removeEventListener("cutu:build-makada", trigger);
  }, [
    project?.id,
    operations,
    replayAvailable,
    loading,
    assemblyCad,
    cadLoading,
    cadError,
  ]);
  useEffect(() => {
    if (
      !buildRequest ||
      buildRequest.projectId !== project?.id ||
      view !== "assembly"
    )
      return;
    if (
      operations.some((operation) => operation.status === "running") ||
      unsavedRef.current ||
      (!assemblyCad && cadError)
    ) {
      acknowledgeBuild(buildRequest, "rejected");
      setBuildRequest(undefined);
      return;
    }
    if (!assemblyCad || cadLoading) return;
    if (availableProgram)
      setSuppressedOperationId(availableProgram.operationId);
    setPlaying(false);
    setPhase(-1);
    setMotionReset((value) => value + 1);
    setReset((value) => value + 1);
    setBuildRun((value) => value + 1);
    setReplayStage(0);
    setBuildRequest(undefined);
    acknowledgeBuild(buildRequest, "started");
  }, [
    buildRequest,
    project?.id,
    view,
    assemblyCad,
    cadLoading,
    cadError,
    operations,
  ]);
  const latest = operations.at(-1);
  const running = operations.some((o) => o.status === "running");
  const renderEpoch = projectEpoch.current;
  return (
    <div className="workbench">
      <header className="topbar">
        <IconButton
          label="Toggle project navigation"
          onClick={() => {
            if (panel && window.innerWidth <= 1200) {
              setPanel(null);
              setSidebar(true);
            } else setSidebar(!sidebar);
          }}
        >
          <Glyph name="menu" />
        </IconButton>
        <a className="brand" href="/" aria-label="Cutu Circuits home">
          <span className="brand-mark">
            <Glyph name="cube" />
          </span>
          <span>Cutu Circuits</span>
        </a>
        <span className="top-divider" />
        <span className="project-breadcrumb">
          {project?.name ?? "Workspace"}
        </span>
        <div className="top-spacer" />
        {operations.filter(op => op.status === "running" && op.capabilityId === "walk").map(op => (
          <Button key={op.id} className="robot-stop" aria-label="Stop active robot" onClick={() => void stopRobot(op)}>
            <Glyph name="stop" />Stop robot
          </Button>
        ))}
        <Button
          aria-label={`Switch to ${colorMode === "light" ? "dark" : "light"} mode`}
          onClick={() => applyTheme(colorMode === "light" ? "dark" : "light")}
        >
          {colorMode === "light" ? "Dark mode" : "Light mode"}
        </Button>
        <Button className="command-button" onClick={() => setPalette(true)}>
          <Glyph name="search" />
          <span>Find a tool</span>
          <kbd>⌘ K</kbd>
        </Button>
        <Tooltip content="Connect the Codex plugin">
          <IconButton
            label="Codex connection"
            onClick={() => setPanel(panel === "codex" ? null : "codex")}
          >
            <Glyph name="code" />
          </IconButton>
        </Tooltip>
        <Button
          className="agent-launch"
          variant="filled"
          aria-label="Cutu agent"
          onClick={() => {
            if (panel !== "agent" && window.innerWidth <= 1200)
              setSidebar(false);
            setPanel(panel === "agent" ? null : "agent");
          }}
        >
          <Glyph name="bolt" />
          <span>Ask Cutu</span>
        </Button>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <IconButton label="Dismiss error" onClick={() => setError("")}>
            <Glyph name="close" />
          </IconButton>
        </div>
      )}
      <div className={`workspace-body${panel ? " has-task-panel" : ""}`}>
        {sidebar && (
          <ProjectSidebar
            projects={projects}
            project={project}
            view={view}
            assetId={assetId}
            selectedId={selection?.entityId}
            onCreate={() => setCreating(true)}
            onProject={(id) => {
              if (safeLeave()) void openProject(id);
            }}
            onView={changeView}
            onSelect={select}
            onAsset={openAsset}
          />
        )}
        <main className="main">
          <ViewToolbar
            view={view}
            onView={changeView}
            dirty={dirty}
            busy={!!busy}
            onSave={() => void save()}
            onCreate={() => setCreating(true)}
            onHistory={() => setHistory(true)}
            onImportRobot={openRobotImport}
            hasProject={!!project}
            hasRobot={!!project?.assets.some((item) => item.kind === "urdf")}
            onTools={() => {
              setPanel(panel === "tools" ? null : "tools");
              if (!capId && project?.hardware?.capabilities[0])
                chooseCapability(project.hardware.capabilities[0]);
            }}
          />
          {loading ? (
            <div className="center-state">
              <span className="loader" />
              Opening workspace…
            </div>
          ) : !project ? (
            <div className="center-state">
              <Glyph name="cube" />
              <h1>
                {error ? "Workspace unavailable" : "Your engineering workspace"}
              </h1>
              <p>
                {error
                  ? "We couldn’t open your local projects. Check that the runtime is running, then try again."
                  : "Create a project to bring circuits, mechanical parts and hardware together."}
              </p>
              <Button
                variant="filled"
                className="control-button accent"
                onClick={() =>
                  error ? window.location.reload() : setCreating(true)
                }
              >
                {error ? "Try again" : "Create project"}
              </Button>
            </div>
          ) : (
            <>
              <div
                className="canvas-area"
                data-build-ready={
                  replayAvailable && !!assemblyCad && !cadLoading
                }
              >
                {view === "assembly" ? (
                  <>
                    <Scene
                      project={project}
                      selected={selection?.entityId ?? null}
                      onSelect={select}
                      playing={playing}
                      phase={phase}
                      cad={assemblyCad}
                      program={
                        replayStage === null ? commandedProgram : undefined
                      }
                      reset={reset}
                      motionReset={motionReset}
                      replayStage={replayStage}
                      replayRun={buildRun}
                    />
                    <div className="canvas-title">
                      <span className="assembly-badge">
                        <Glyph name="cube" /> Assembly
                      </span>
                      <h1>{project.name}</h1>
                      {cadLoading && (
                        <span className="cad-status">
                          {assemblyCad
                            ? "Checking design changes…"
                            : "Preparing assembly…"}
                        </span>
                      )}
                      {cadError && (
                        <span className="cad-status" role="status">
                          Native CAD unavailable: {cadError}. Showing an
                          illustrative model.
                        </span>
                      )}
                    </div>
                    <div className="canvas-tools">
                      {project.assets.some((a) => a.kind === "cad") && (
                        <IconButton
                          label="Refresh native CAD geometry"
                          disabled={!!busy}
                          onClick={() => setCadForceRevision((v) => v + 1)}
                        >
                          <Glyph name="cube" />
                        </IconButton>
                      )}
                      <Tooltip content="Fit assembly · F">
                        <IconButton
                          label="Fit assembly (F)"
                          onClick={() => setReset((v) => v + 1)}
                        >
                          <Glyph name="fit" />
                        </IconButton>
                      </Tooltip>
                    </div>
                    <div className="canvas-caption">
                      <span>Perspective</span>
                      <span>mm · Z up</span>
                    </div>
                  </>
                ) : view === "source" ? (
                  <SourceEditor
                    project={project}
                    asset={asset}
                    assetId={assetId}
                    file={file}
                    content={content}
                    conflict={conflict}
                    busy={busy}
                    dirty={dirty}
                    compiled={compiled}
                    onAsset={(id) => {
                      if (safeLeave()) {
                        setFile(undefined);
                        setAssetId(id);
                      }
                    }}
                    compile={compile}
                    exportAsset={exportAsset}
                    setContent={(value) => {
                      setContent(value);
                      setCompiled(undefined);
                    }}
                    onReload={() => {
                      if (
                        !file ||
                        !window.confirm(
                          "Replace your edits with the latest source?",
                        )
                      )
                        return;
                      const epoch = projectEpoch.current;
                      const scope = activeEditor.current;
                      api<FileSnapshot>(
                        `${base}/files?path=${encodeURIComponent(file.path)}`,
                      )
                        .then((s) => {
                          if (
                            epoch !== projectEpoch.current ||
                            scope !== activeEditor.current
                          )
                            return;
                          setFile(s);
                          setContent(s.content);
                          setConflict(false);
                        })
                        .catch((e) => {
                          if (
                            epoch === projectEpoch.current &&
                            scope === activeEditor.current
                          )
                            fail(e);
                        });
                    }}
                  />
                ) : view === "robot" && asset ? (
                  <EditorBoundary
                    key={`${project.id}:${asset.id}`}
                    onSource={() => changeView("source")}
                  >
                    <Suspense
                      fallback={
                        <div className="center-state">
                          <span className="loader" />
                          Loading robot workspace…
                        </div>
                      }
                    >
                      <RobotWorkspace
                        project={project}
                        asset={asset}
                        onOpenSource={() => changeView("source")}
                        onSelection={select}
                        onNotice={setNotice}
                      />
                    </Suspense>
                  </EditorBoundary>
                ) : asset ? (
                  <EditorBoundary
                    key={asset.id}
                    onSource={() => changeView("source")}
                  >
                    <Suspense
                      fallback={
                        <div className="center-state">
                          <span className="loader" />
                          Loading native {view} editor…
                        </div>
                      }
                    >
                      {view === "circuit" ? (
                        <CircuitEditor
                          key={asset.id}
                          project={project}
                          asset={asset}
                        />
                      ) : (
                        <CadEditor
                          key={asset.id}
                          project={project}
                          asset={asset}
                        />
                      )}
                    </Suspense>
                  </EditorBoundary>
                ) : (
                  <div className="center-state">
                    <Glyph name={view === "circuit" ? "chip" : "cube"} />
                    <h2>
                      No {view === "cad" ? "CAD" : view} source in this project
                    </h2>
                    <p>
                      Choose a project with native{" "}
                      {view === "cad" ? ".replicad.ts" : ".circuit.tsx"} files
                      from the project menu.
                    </p>
                  </div>
                )}
                {selected && view === "assembly" && (
                  <EntityInspector
                    project={project}
                    selected={selected}
                    select={select}
                    onOpenAsset={(target, source) =>
                      openAsset(target.id, source)
                    }
                  />
                )}
              </div>
              {replayAvailable && view === "assembly" && (
                <AssemblyReplay
                  key={project.id}
                  stage={replayStage}
                  run={buildRun}
                  onStage={setReplayStage}
                />
              )}
              {project.hardware?.capabilities.some(c => c.id === "walk") && view === "assembly" && replayStage === null && (
                <RobotWalkControls operations={operations} busy={!!busy}
                  maxCycles={Number((project.hardware.capabilities.find(c => c.id === "walk")?.inputSchema.properties as any)?.steps?.maximum ?? 20)}
                  onWalk={cycles => void walkForward(cycles)}
                  onStop={op => void stopRobot(op)}
                  onDetails={() => {
                    const walk = project.hardware?.capabilities.find(c => c.id === "walk");
                    if (walk) chooseCapability(walk);
                    setPanel("tools");
                  }} />
              )}
              {latest && latest.status === "running" && latest.capabilityId !== "walk" && panel !== "tools" && (
                <button
                  className="operation-strip"
                  onClick={() => setPanel("tools")}
                >
                  <span className={`status-dot ${latest.status}`} />
                  <span>{latest.label}</span>
                  <span>{latest.status}</span>
                  <Glyph name="chevron" />
                </button>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>
              {busy ||
                (view === "assembly"
                  ? "Drag to orbit · Shift drag to pan · Scroll to zoom"
                  : asset
                    ? artifactLabel(asset)
                    : "Choose a design")}
            </span>
            <span>
              {dirty || nativeDirty
                ? "Unsaved changes"
                : running
                  ? "Operation running"
                  : selection?.origin === "codex"
                    ? "Selection from Codex"
                    : "Local project"}
              <span className="footer-separator">·</span>
              {view === "robot" ? "m · kg · s" : (project?.units ?? "mm")}
            </span>
          </footer>
        </main>
        {panel && (
          <aside
            className={`task-panel${panel === "agent" ? " agent-task-panel" : ""}`}
          >
            <div className="panel-header">
              <h2>
                {panel === "agent"
                  ? "Cutu agent"
                  : panel === "codex"
                    ? "Codex connection"
                    : "Project capabilities"}
              </h2>
              <IconButton label="Close panel" onClick={() => setPanel(null)}>
                <Glyph name="close" />
              </IconButton>
            </div>
            {panel === "agent" ? (
              <AgentPanel
                key={project?.id}
                projectId={project?.id}
                projectName={project?.name}
                onCodex={() => setPanel("codex")}
              />
            ) : panel === "codex" ? (
              <CodexPanel projectId={project?.id} />
            ) : (
              <CapabilitiesPanel
                capabilities={project?.hardware?.capabilities ?? []}
                capability={capability}
                inputs={inputs}
                onChoose={chooseCapability}
                onInputs={setInputs}
                onRun={() => void run()}
                busy={!!busy}
                operations={operations}
                onSend={async (op, message) => {
                  await api(`${base}/operations/${op.id}/send`, { message });
                }}
                onCancel={(op) => {
                  const epoch = projectEpoch.current;
                  api<Operation>(`${base}/operations/${op.id}/cancel`, {})
                    .then((next) => {
                      if (epoch === projectEpoch.current)
                        setOperations((items) =>
                          items.map((item) =>
                            item.id === next.id ? next : item,
                          ),
                        );
                    })
                    .catch((e) => {
                      if (epoch === projectEpoch.current) fail(e);
                    });
                }}
              />
            )}
          </aside>
        )}
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onOpenChangeComplete={restoreCreateFocus}
        name={newName}
        onName={setNewName}
        template={template}
        onTemplate={setTemplate}
        busy={!!busy}
        onCreate={() => void create()}
      />
      {project && (
        <HistoryPanel
          key={project.id}
          project={project}
          initialPath={asset?.path}
          open={history}
          onOpenChange={setHistory}
          onOpenChangeComplete={restoreHistoryFocus}
          blocked={dirty || nativeDirty}
          revision={historyRevision}
          onRestored={(snapshot) => {
            if (renderEpoch !== projectEpoch.current) return;
            if (fileRef.current?.path === snapshot.path && !dirtyRef.current) {
              setFile(snapshot);
              setContent(snapshot.content);
              setConflict(false);
            }
            setCadRevision((value) => value + 1);
            setCompiled(undefined);
          }}
        />
      )}
      {project && importingRobot && (
        <Suspense fallback={null}>
          <RobotImportDialog
            project={project}
            onClose={() => setImportingRobot(false)}
            onImported={async (importedAsset) => {
              if (renderEpoch !== projectEpoch.current) return;
              const epoch = projectEpoch.current;
              await openProject(project.id);
              // Opening a project advances the epoch once on request and once on success.
              if (projectEpoch.current !== epoch + 2) return;
              setAssetId(importedAsset.id);
              setView("robot");
              setNotice("Robot imported");
            }}
          />
        </Suspense>
      )}
      <ToolPalette
        open={palette}
        onOpenChange={setPalette}
        onOpenChangeComplete={restorePaletteFocus}
        query={query}
        onQuery={setQuery}
        commands={[
          { label: "Assembly", action: () => changeView("assembly") },
          { label: "Circuit editor", action: () => changeView("circuit") },
          { label: "CAD editor", action: () => changeView("cad") },
          { label: "Native source", action: () => changeView("source") },
          ...(project?.assets.some((item) => item.kind === "urdf")
            ? [{ label: "Robot workspace", action: () => changeView("robot") }]
            : []),
          ...(project
            ? [
                { label: "Version history", action: () => setHistory(true) },
                { label: "Import URDF", action: openRobotImport },
              ]
            : []),
          { label: "Fit assembly", action: () => setReset((v) => v + 1) },
          { label: "Project capabilities", action: () => setPanel("tools") },
          { label: "Connect Codex", action: () => setPanel("codex") },
          { label: "New project", action: () => setCreating(true) },
          ...(project?.entities.map((e) => ({
            label: e.name,
            action: () => {
              changeView("assembly");
              select(e.id);
            },
          })) ?? []),
        ]}
      />
    </div>
  );
}
