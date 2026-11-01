import { OfflineCadViewer } from '@tscircuit/3d-viewer';

export const TSCIRCUIT_3D_VIEWER_VERSION = '0.0.577' as const;

// Exact-version patch export. Unlike the package's public CadViewer, this uses
// only its bundled JSCAD renderer and has no Manifold CDN or global toaster path.
export const Tscircuit3dViewer = OfflineCadViewer;

export function inspectThreeDViewerContract(candidate: unknown): {
  usable: boolean;
  renderer: 'offline-jscad' | 'unavailable';
  reason?: string;
} {
  if (typeof candidate !== 'function') {
    return {
      usable: false,
      renderer: 'unavailable',
      reason: 'The pinned offline 3D viewer export is missing.',
    };
  }
  return {
    usable: true,
    renderer: 'offline-jscad',
    reason: 'Pinned read-only JSCAD renderer; external model URLs are blocked by the pane.',
  };
}
