import type { Project } from '@cutucircuits/core';

/** Resolve native URDF paths without granting a model access outside its project. */
export function projectPath(path: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('/') || /[?#\\\0]/.test(path))
    throw new Error(`Only project-local mesh paths are supported: ${path}`);
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) throw new Error('A mesh path points outside this project.');
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length) throw new Error('A mesh path is empty.');
  return segments.join('/');
}

export function meshCandidates(filename: string, urdfPath: string): string[] {
  if (/[?#\\\0]/.test(filename)) throw new Error(`Only project-local mesh paths are supported: ${filename}`);
  filename = decodeURIComponent(filename);
  const directory = urdfPath.includes('/') ? urdfPath.slice(0, urdfPath.lastIndexOf('/') + 1) : '';
  if (filename.startsWith('package://')) {
    return [projectPath(filename.slice('package://'.length))];
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(filename) || filename.startsWith('/'))
    throw new Error(`Only project-local mesh paths are supported: ${filename}`);
  return [projectPath(directory + filename)];
}

export function projectResources(project: Project, urdfPath: string, signal: AbortSignal) {
  const prefix = `/api/projects/${encodeURIComponent(project.id)}/assets/raw?path=`;
  const cache = new Map<string, Promise<{ data: ArrayBuffer; path: string }>>();
  const resolve = (filename: string) => {
    if (!cache.has(filename)) cache.set(filename, (async () => {
      const candidates = meshCandidates(filename, urdfPath);
      for (const path of candidates) {
        const response = await fetch(prefix + encodeURIComponent(path), { signal });
        if (response.ok) return { data: await response.arrayBuffer(), path };
        if (response.status !== 404) throw new Error(`Could not load mesh ${path} (${response.status}).`);
      }
      throw new Error(`Mesh not found in this project: ${filename}. Add its companion files beside the URDF or preserve the package directory.`);
    })());
    return cache.get(filename)!;
  };
  return { resolve, meshResolver: async (filename: string) => (await resolve(filename)).data, rawUrl: (path: string) => prefix + encodeURIComponent(projectPath(path)) };
}
