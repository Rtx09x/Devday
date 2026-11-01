import { readPreviewThemeColors } from './themeColors';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { EditorHost, EditorHostProps } from '@cutucircuits/editor-host';
import { meshToStats } from './geometry';
import { replicadMeshToGeometry } from './previewGeometry';
import { formatNumber, getErrorMessage } from './utils';
import type { ModelStats, ReplicadMesh } from './types';

type MeshAssetFormat = 'obj' | 'stl';

interface MeshAssetState {
  mesh: ReplicadMesh;
  stats: ModelStats;
}

function useBinaryFileContent(
  host: EditorHost,
  applyContent: (content: ArrayBuffer) => void
): { isLoading: boolean; error: Error | null; theme: string } {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [theme, setTheme] = useState(host.theme);
  const applyContentRef = useRef(applyContent);
  applyContentRef.current = applyContent;

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await host.loadBinaryContent();
      applyContentRef.current(data);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    } finally {
      setIsLoading(false);
    }
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void host
      .loadBinaryContent()
      .then((data) => {
        if (cancelled) return;
        applyContentRef.current(data);
        setError(null);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  useEffect(() => host.onFileChanged(() => void load()), [host, load]);
  useEffect(() => host.onThemeChanged(setTheme), [host]);

  return { isLoading, error, theme };
}

function meshFromGeometry(source: THREE.BufferGeometry, format: MeshAssetFormat, matrix?: THREE.Matrix4): ReplicadMesh {
  const geometry = source.clone();
  if (matrix) {
    geometry.applyMatrix4(matrix);
  }
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }

  const position = geometry.getAttribute('position');
  if (!position || position.itemSize !== 3 || position.count === 0) {
    geometry.dispose();
    throw new Error(`${format.toUpperCase()} did not contain any triangle vertices.`);
  }

  const normal = geometry.getAttribute('normal');
  const vertices = Array.from(position.array as ArrayLike<number>);
  const normals =
    normal && normal.itemSize === 3 && normal.count === position.count
      ? Array.from(normal.array as ArrayLike<number>)
      : [];
  const triangles = geometry.index
    ? Array.from(geometry.index.array as ArrayLike<number>)
    : Array.from({ length: position.count }, (_value, index) => index);

  geometry.dispose();
  return { vertices, triangles, normals };
}

function mergeReplicadMeshes(meshes: ReplicadMesh[], format: MeshAssetFormat): ReplicadMesh {
  if (meshes.length === 0) {
    throw new Error(`${format.toUpperCase()} did not contain any mesh objects.`);
  }
  const vertices: number[] = [];
  const triangles: number[] = [];
  const normals: number[] = [];
  let offset = 0;
  for (const mesh of meshes) {
    vertices.push(...mesh.vertices);
    if (mesh.normals.length === mesh.vertices.length) normals.push(...mesh.normals);
    for (const index of mesh.triangles) triangles.push(index + offset);
    offset += mesh.vertices.length / 3;
  }
  return { vertices, triangles, normals: normals.length === vertices.length ? normals : [] };
}

function parseStl(data: ArrayBuffer): MeshAssetState {
  const loader = new STLLoader();
  const geometry = loader.parse(data);
  try {
    const mesh = meshFromGeometry(geometry, 'stl');
    return { mesh, stats: meshToStats(mesh) };
  } finally {
    geometry.dispose();
  }
}

function parseObj(data: ArrayBuffer): MeshAssetState {
  const text = new TextDecoder().decode(data);
  const group = new OBJLoader().parse(text);
  try {
    group.updateWorldMatrix(true, true);
    const meshes: ReplicadMesh[] = [];
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
      child.updateWorldMatrix(true, false);
      meshes.push(meshFromGeometry(child.geometry, 'obj', child.matrixWorld));
    });
    const mesh = mergeReplicadMeshes(meshes, 'obj');
    return { mesh, stats: meshToStats(mesh) };
  } finally {
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry?.dispose();
      const material = child.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material?.dispose();
      }
    });
  }
}

function parseMeshAsset(data: ArrayBuffer, format: MeshAssetFormat): MeshAssetState {
  return format === 'obj' ? parseObj(data) : parseStl(data);
}



interface MeshPreviewProps {
  mesh: ReplicadMesh;
  wireframe: boolean;
  theme: string;
}

function MeshPreview({ mesh, wireframe, theme }: MeshPreviewProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const renderedMeshRef = useRef<THREE.Mesh | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);

  const renderScene = useCallback(() => {
    if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;
    rendererRef.current.render(sceneRef.current, cameraRef.current);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = readPreviewThemeColors('replicad-mesh-editor');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.background);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    camera.position.set(110, 90, 110);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.addEventListener('change', renderScene);

    scene.add(new THREE.AmbientLight('#ffffff', 0.85));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.1);
    keyLight.position.set(120, 180, 80);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#9bb5ff', 0.45);
    fillLight.position.set(-120, -80, -100);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(240, 24, colors.gridB, colors.gridA);
    scene.add(grid);
    gridRef.current = grid;

    const modelGroup = new THREE.Group();
    modelGroup.rotateX(-Math.PI / 2);
    scene.add(modelGroup);
    modelGroupRef.current = modelGroup;

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    const resizeObserver = new ResizeObserver(() => {
      if (!rendererRef.current || !cameraRef.current) return;
      const safeWidth = Math.max(container.clientWidth, 1);
      const safeHeight = Math.max(container.clientHeight, 1);
      rendererRef.current.setSize(safeWidth, safeHeight);
      cameraRef.current.aspect = safeWidth / safeHeight;
      cameraRef.current.updateProjectionMatrix();
      renderScene();
    });
    resizeObserver.observe(container);
    renderScene();

    return () => {
      resizeObserver.disconnect();
      controls.removeEventListener('change', renderScene);
      controls.dispose();
      renderedMeshRef.current?.geometry.dispose();
      (renderedMeshRef.current?.material as THREE.Material | undefined)?.dispose?.();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      modelGroupRef.current = null;
      renderedMeshRef.current = null;
      gridRef.current = null;
    };
  }, [renderScene]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const colors = readPreviewThemeColors('replicad-mesh-editor');
    scene.background = new THREE.Color(colors.background);
    if (gridRef.current) {
      scene.remove(gridRef.current);
      const replacement = new THREE.GridHelper(240, 24, colors.gridB, colors.gridA);
      scene.add(replacement);
      gridRef.current = replacement;
    }
    renderScene();
  }, [theme, renderScene]);

  useEffect(() => {
    const modelGroup = modelGroupRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!modelGroup || !camera || !controls) return;

    if (renderedMeshRef.current) {
      modelGroup.remove(renderedMeshRef.current);
      renderedMeshRef.current.geometry.dispose();
      (renderedMeshRef.current.material as THREE.Material).dispose();
      renderedMeshRef.current = null;
    }

    const colors = readPreviewThemeColors('replicad-mesh-editor');
    const geometry = replicadMeshToGeometry(mesh);
    const material = new THREE.MeshStandardMaterial({
      color: colors.mesh,
      metalness: 0.05,
      roughness: 0.7,
      wireframe,
      side: THREE.DoubleSide,
    });
    const object = new THREE.Mesh(geometry, material);
    object.frustumCulled = false;
    renderedMeshRef.current = object;
    modelGroup.add(object);

    modelGroup.updateMatrixWorld(true);
    const overall = new THREE.Box3().setFromObject(modelGroup);
    const center = new THREE.Vector3();
    overall.getCenter(center);
    const sphere = new THREE.Sphere();
    overall.getBoundingSphere(sphere);
    const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 50;
    const distance = Math.max(radius * 2.6, 48);
    camera.near = Math.max(distance / 100, 0.1);
    camera.far = distance * 40;
    camera.position.set(center.x + distance, center.y + distance * 0.72, center.z + distance);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    renderScene();
  }, [mesh, wireframe, renderScene]);

  return <div ref={containerRef} className="replicad-preview-canvas" />;
}

export function MeshAssetEditor({ host }: EditorHostProps): React.ReactElement {
  const format: MeshAssetFormat = host.filePath.toLowerCase().endsWith('.obj') ? 'obj' : 'stl';
  const formatLabel = format.toUpperCase();
  const [meshState, setMeshState] = useState<MeshAssetState | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);

  const { isLoading, error: loadError, theme } = useBinaryFileContent(
    host,
    useCallback((content: ArrayBuffer) => {
      try {
        const parsed = parseMeshAsset(content, format);
        setMeshState(parsed);
        setParseError(null);
      } catch (error) {
        setMeshState(null);
        setParseError(getErrorMessage(error));
      }
    }, [format])
  );

  const stats = meshState?.stats ?? null;
  const error = loadError ? getErrorMessage(loadError) : parseError;
  const statusState: 'working' | 'ok' | 'error' | 'idle' = isLoading ? 'working' : error ? 'error' : stats ? 'ok' : 'idle';
  const statusLabel = isLoading
    ? 'Loading...'
    : error
      ? `Could not parse ${formatLabel}`
      : stats
        ? `${stats.triangleCount.toLocaleString()} tris`
        : 'No mesh';

  return (
    <div className="replicad-editor replicad-mesh-editor">
      <div className="replicad-toolbar">
        <div className="replicad-toolbar-group">
          <span className="replicad-filename" title={host.filePath}>
            {host.fileName}
          </span>
        </div>
        <div className="replicad-toolbar-group">
          <button type="button" onClick={() => setWireframe((value) => !value)} aria-pressed={wireframe}>
            {wireframe ? 'Shaded' : 'Wireframe'}
          </button>
          <span className="replicad-status" data-state={statusState} role="status" aria-live="polite">
            <span className="replicad-status-dot" />
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="replicad-mesh-stage">
        {meshState ? (
          <MeshPreview mesh={meshState.mesh} wireframe={wireframe} theme={theme} />
        ) : (
          <div className="replicad-preview-empty">
            {isLoading
              ? `Loading ${formatLabel}...`
              : error
                ? `${formatLabel} parse failed: ${error}`
                : `No ${formatLabel} geometry to display.`}
          </div>
        )}

        {stats ? (
          <div className="replicad-stats-overlay">
            <strong>
              {formatNumber(stats.boundingBox.size[0])} x {formatNumber(stats.boundingBox.size[1])} x{' '}
              {formatNumber(stats.boundingBox.size[2])} mm
            </strong>
            <span>{stats.triangleCount.toLocaleString()} tris</span>
            {stats.volume > 0 ? <span>{formatNumber(stats.volume / 1000)} cm3</span> : null}
            <span className={stats.watertight ? 'replicad-ok' : 'replicad-warn'}>
              {stats.watertight ? 'watertight' : 'not watertight'}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
