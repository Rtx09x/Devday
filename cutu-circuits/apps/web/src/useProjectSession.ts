import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Operation,
  Project,
  ProjectSummary,
  Selection,
} from "@cutucircuits/core";
import { api } from "./api";
interface FileEvent {
  path?: string;
  paths?: string[];
}
interface Callbacks {
  onOpened: () => void;
  onFilesChanged: (
    files: FileEvent | undefined,
    current: () => boolean,
  ) => void;
  onError: (error: unknown) => void;
  onReconciled?: () => void;
}
/** A project switch invalidates every pending request from the previous session. */
export function useProjectSession(callbacks: Callbacks) {
  const handlers = useRef(callbacks);
  handlers.current = callbacks;
  const generation = useRef(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project>();
  const [selection, setSelection] = useState<Selection>();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const loadProjects = useCallback(async () => {
    const list = await api<ProjectSummary[]>("/projects");
    setProjects(list);
    return list;
  }, []);
  const openProject = useCallback(async (id: string) => {
    const scope = ++generation.current;
    setLoading(true);
    try {
      const [next, selected, activity] = await Promise.all([
        api<Project>(`/projects/${id}`),
        api<Selection>(`/projects/${id}/selection`),
        api<Operation[]>(`/projects/${id}/operations`),
      ]);
      if (generation.current !== scope) return;
      setProject(next);
      setSessionKey(scope);
      setSelection(selected);
      setOperations(activity);
      localStorage.setItem("cutucircuits:active-project", next.id);
      handlers.current.onOpened();
    } catch (error) {
      if (generation.current === scope) {
        setProject(undefined);
        handlers.current.onError(error);
      }
    } finally {
      if (generation.current === scope) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    loadProjects()
      .then((list) => {
        if (!active) return;
        const stored = localStorage.getItem("cutucircuits:active-project");
        const initial =
          list.find((p) => p.id === stored) ??
          list.find((p) => ["makada", "spidey"].includes(p.name.toLowerCase())) ??
          list[0];
        if (initial) void openProject(initial.id);
        else setLoading(false);
      })
      .catch((error) => {
        if (active) {
          handlers.current.onError(error);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [loadProjects, openProject]);
  useEffect(() => {
    if (!project?.id) return;
    const id = project.id;
    const scope = generation.current;
    let active = true;
    const current = () => active && generation.current === scope;
    const events = new EventSource(`/api/projects/${id}/events`);
    const guarded = <T>(request: Promise<T>, apply: (value: T) => void) =>
      request
        .then((value) => {
          if (current()) apply(value);
        })
        .catch((error) => {
          if (current()) handlers.current.onError(error);
        });
    const reconcile = () => {
      void guarded(api<Project>(`/projects/${id}`), (next) => {
        setProject(next);
        handlers.current.onReconciled?.();
      });
      void guarded(api<Selection>(`/projects/${id}/selection`), setSelection);
      void guarded(
        api<Operation[]>(`/projects/${id}/operations`),
        setOperations,
      );
    };
    // SSE has no event replay. A browser can also resume networking while its
    // EventSource still appears open, so both signals reconcile the same scope.
    const reconnect = () => {
      if (!current()) return;
      reconcile();
      handlers.current.onFilesChanged(undefined, current);
    };
    events.onopen = reconnect;
    window.addEventListener("online", reconnect);
    events.onmessage = (event) => {
      if (!current()) return;
      let message: { type: string; data?: FileEvent };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "presentation.requested") {
        const data = message.data as unknown as { requestId?: string; action?: string };
        if (data && typeof data.requestId === "string" && ["start", "stop"].includes(data.action ?? ""))
          window.dispatchEvent(new CustomEvent("cutu:build-makada", {
            detail: { projectId: id, requestId: data.requestId, action: data.action },
          }));
      }
      if (message.type === "selection.updated")
        void guarded(api<Selection>(`/projects/${id}/selection`), setSelection);
      if (message.type === "operation.updated")
        void guarded(
          api<Operation[]>(`/projects/${id}/operations`),
          setOperations,
        );
      if (
        message.type === "project.updated" ||
        message.type === "file.updated"
      ) {
        void guarded(api<Project>(`/projects/${id}`), setProject);
        void guarded(api<ProjectSummary[]>("/projects"), setProjects);
      }
      if (message.type === "file.updated")
        handlers.current.onFilesChanged(message.data, current);
    };
    return () => {
      active = false;
      window.removeEventListener("online", reconnect);
      events.close();
    };
  }, [project?.id, sessionKey]);
  const select = useCallback((entityId: string | null) => {
    const active = projectRef.current;
    if (!active) return;
    const scope = generation.current;
    api<Selection>(
      `/projects/${active.id}/selection`,
      { entityId, origin: "workspace" },
      "PUT",
    )
      .then((next) => {
        if (scope === generation.current) setSelection(next);
      })
      .catch((error) => {
        if (scope === generation.current) handlers.current.onError(error);
      });
  }, []);
  return {
    projects,
    project,
    selection,
    operations,
    setOperations,
    loading,
    loadProjects,
    openProject,
    select,
  };
}
