import { AssemblyViewer } from '@tscircuit/assembly-viewer';

export const TSCIRCUIT_ASSEMBLY_VIEWER_VERSION = '0.0.6' as const;

export const TscircuitAssemblyViewer = AssemblyViewer;

export function inspectAssemblyViewerContract(candidate: unknown): {
  usable: boolean;
  reason: string;
} {
  if (typeof candidate !== 'function') {
    return {
      usable: false,
      reason: 'The pinned direct assembly viewer export is missing.',
    };
  }
  return {
    usable: true,
    reason: 'Pinned read-only assembly viewer with Electronics Studio selection bridging.',
  };
}
