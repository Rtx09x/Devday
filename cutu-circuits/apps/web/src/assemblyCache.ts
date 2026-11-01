import type { CadResult, EngineResult, FileSnapshot, Project } from "@cutucircuits/core";

/** The scene uses only these project fields, not graph revisions or assets. */
export const sceneIdentity = (project: Project) =>
  JSON.stringify([project.id, project.entities, project.motion]);

/** Cache successful and in-flight native results within this browser session. */
export function createAssemblyCache(
  read: (projectId: string, path: string) => Promise<FileSnapshot>,
  compile: (projectId: string, path: string, force: boolean) => Promise<EngineResult>,
) {
  const models = new Map<string, Promise<CadResult>>();
  return async (projectId: string, path: string, active: () => boolean = () => true, force = false): Promise<CadResult> => {
    const snapshot = await read(projectId, path);
    if (!active()) throw new DOMException("Assembly request cancelled", "AbortError");
    const key = JSON.stringify([projectId, path, snapshot.sha256]);
    if (force) models.delete(key);
    let result = models.get(key);
    if (!result) {
      result = compile(projectId, path, force).then((model) => {
        if (model.kind !== "cad") throw new Error("The native model did not return CAD geometry.");
        if (model.sourceSha256 !== snapshot.sha256)
          throw new Error("The model changed during compilation. Compile again to refresh.");
        return model;
      });
      models.set(key, result);
      const pending = result;
      void result.catch(() => { if (models.get(key) === pending) models.delete(key); });
      while (models.size > 8) models.delete(models.keys().next().value!);
    }
    return result;
  };
}
