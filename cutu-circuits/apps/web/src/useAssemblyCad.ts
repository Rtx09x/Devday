import { useEffect, useRef, useState } from "react";
import type {
  Project,
  CadResult,
  FileSnapshot,
  EngineResult,
} from "@cutucircuits/core";
import { api } from "./api";
import { createAssemblyCache } from "./assemblyCache";
const loadModel = createAssemblyCache(
  (id, path) => api<FileSnapshot>(`/projects/${id}/files?path=${encodeURIComponent(path)}`),
  (id, path, force) => api<EngineResult>(`/projects/${id}/compile`, { path, ...(force ? { force: true } : {}) }),
);
/** Native source hashes keep reused assembly meshes coherent with editor and Codex saves. */
export function useAssemblyCad(project: Project | undefined, revision: number, forceRevision = 0) {
  const [result, setResult] = useState<{ generation: number; cad: CadResult }>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const asset = project?.assets.find((a) => a.kind === "cad");
  const identity = project && asset ? JSON.stringify([project.id, asset.path]) : undefined;
  const scope = useRef({ identity, generation: 0 });
  if (scope.current.identity !== identity) scope.current = { identity, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const previousForceRevision = useRef(forceRevision);
  const forcePending = useRef(false);
  useEffect(() => {
    let cancelled = false;
    if (previousForceRevision.current !== forceRevision) forcePending.current = true;
    previousForceRevision.current = forceRevision;
    setError("");
    if (!project || !asset) {
      setLoading(false);
      return;
    }
    setLoading(true);
    async function load() {
      const model = await loadModel(project!.id, asset!.path, () => !cancelled, forcePending.current);
      if (!cancelled) {
        forcePending.current = false;
        setResult({ generation, cad: model });
      }
    }
    void load()
      .catch((e) => {
        if (!cancelled) {
          setResult(undefined);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, asset?.path, revision, forceRevision]);
  // Never display another project's model, even before the effect runs.
  return { cad: result?.generation === generation && identity ? result.cad : undefined, loading, error };
}
