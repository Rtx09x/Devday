import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import Button from '@cutucircuits/ui/button';
import Menu, { ContextMenu, MenuItem } from '@cutucircuits/ui/menu';
import Tooltip from '@cutucircuits/ui/tooltip';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MonacoEditor } from '@cutucircuits/editor-host/runtime';
import type { EditorHostProps, ExtensionContext, ExtensionStorage } from '@cutucircuits/editor-host';
import { buildProjectGraph } from './projectIndex';
import type { ProjectGraphResult } from './projectIndex';
import { compileReplicad } from './runtime/client';
import { replicadMeshToGeometry } from './previewGeometry';
import { analyzePrintability } from './printability';
import { readPreviewThemeColors } from './themeColors';
import { mergeMeshes } from './geometry';
import { createWorldSectionPlane, modelAxisRanges } from './sectionPlane';
import type { AxisRange, SectionAxis } from './sectionPlane';
import {
  isShapeVisible,
  reconcileShapeVisibility,
  soloShapeVisibility,
  toggleShapeVisibility,
} from './shapeVisibility';
import type { ShapeVisibility } from './shapeVisibility';
import { ParamsPanel } from './ParamsPanel';
import {
  buildReplicadSelection,
  meshBoundingBox,
  refreshReplicadSelection,
  selectionContextItem,
  selectionContextDescription,
  selectionContextLabel,
} from './selection';
import { formatNumber, getErrorMessage, resolveWorkspacePath } from './utils';
import { registerReplicadIntellisense } from './monacoIntellisense';
import { compileMessagesToMarkers } from './compileDiagnostics';
import type { CompileMarkerData, MarkerSeverityValues } from './compileDiagnostics';
import type {
  AnimationData,
  CompileMessage,
  CompileResult,
  ExportFormat,
  ModelStats,
  ParamDef,
  ParamValues,
  ReplicadConventions,
  ReplicadEditorAPI,
  ReplicadMesh,
  ReplicadProjectGraph,
  ReplicadSelection,
  ShapeResult,
  StepAsset,
  FontAsset,
  ViewName,
} from './types';

// The model group is rotated -90deg about X so Replicad's Z-up geometry displays
// in Three's Y-up world. Geometry stays in model space (so animation transforms,
// authored in model space, apply correctly); the parent does the axis swap. View
// directions are in the resulting Y-up world space.
const VIEW_DIRECTIONS: Record<ViewName, [number, number, number]> = {
  iso: [1, 1, 1],
  top: [0, 1, 0],
  front: [0, 0, 1],
  right: [1, 0, 0],
};

type ProjectionMode = 'perspective' | 'orthographic';
type PreviewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

interface PersistedCameraState {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  projection: ProjectionMode;
  zoom?: number;
  orthographicHeight?: number;
}

const CAMERA_STORAGE_KEY_PREFIX = 'preview.camera.v1';
const CAMERA_PERSIST_DEBOUNCE_MS = 250;
const PERSPECTIVE_FOV_DEG = 35;
const CAMERA_FIT_MARGIN = 1.15;

function viewDirection(view: ViewName): THREE.Vector3 {
  return new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize();
}

function placeCameraForView(
  camera: THREE.Camera,
  target: THREE.Vector3,
  distance: number,
  view: ViewName
): void {
  camera.position.copy(target).addScaledVector(viewDirection(view), distance);
  camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0);
  camera.lookAt(target);
}

function updateCameraForViewport(camera: PreviewCamera, width: number, height: number): void {
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
  } else {
    const verticalSpan = camera.top - camera.bottom;
    camera.left = (-verticalSpan * aspect) / 2;
    camera.right = (verticalSpan * aspect) / 2;
  }
  camera.updateProjectionMatrix();
}

function fitCameraToSphere(
  camera: PreviewCamera,
  target: THREE.Vector3,
  radius: number,
  direction: THREE.Vector3,
  aspect: number
): void {
  const safeDirection = direction.lengthSq() > 1e-8 ? direction.clone().normalize() : viewDirection('iso');
  let distance: number;
  if (camera instanceof THREE.PerspectiveCamera) {
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(aspect, 0.01));
    const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
    distance = (radius * CAMERA_FIT_MARGIN) / Math.max(Math.sin(limitingHalfFov), 0.01);
  } else {
    const verticalSpan = radius * 2 * CAMERA_FIT_MARGIN;
    camera.top = verticalSpan / 2;
    camera.bottom = -verticalSpan / 2;
    camera.left = (-verticalSpan * Math.max(aspect, 0.01)) / 2;
    camera.right = (verticalSpan * Math.max(aspect, 0.01)) / 2;
    camera.zoom = 1;
    distance = Math.max(radius * 3, 48);
  }
  camera.position.copy(target).addScaledVector(safeDirection, distance);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = Math.max(distance * 40, radius * 40);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

function isFiniteVectorTuple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function cameraStorageKey(modelFilePath: string): string {
  return `${CAMERA_STORAGE_KEY_PREFIX}:${modelFilePath}`;
}

function readPersistedCamera(storage: ExtensionStorage, modelFilePath: string): PersistedCameraState | null {
  const value = storage.get<Partial<PersistedCameraState>>(cameraStorageKey(modelFilePath));
  if (
    !value ||
    !isFiniteVectorTuple(value.position) ||
    !isFiniteVectorTuple(value.target) ||
    (value.projection !== 'perspective' && value.projection !== 'orthographic') ||
    (value.up !== undefined && !isFiniteVectorTuple(value.up)) ||
    (value.zoom !== undefined && (typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) || value.zoom <= 0)) ||
    (value.orthographicHeight !== undefined &&
      (typeof value.orthographicHeight !== 'number' ||
        !Number.isFinite(value.orthographicHeight) ||
        value.orthographicHeight <= 0))
  ) {
    return null;
  }
  return value as PersistedCameraState;
}

const TOOLBAR_EXPORT_FORMATS: readonly ExportFormat[] = ['stl', 'step', 'obj'];
const PICK_MOVEMENT_THRESHOLD_PX = 5;
const SECTION_PICK_EPSILON_MM = 1e-6;
const SELECTION_ACCENT = '#f59e0b';

function clampToAxisRange(value: number, range: AxisRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function setMaterialClippingPlanes(material: THREE.Material, clippingPlanes: THREE.Plane[]): void {
  const hadClipping = Boolean(material.clippingPlanes?.length);
  const hasClipping = clippingPlanes.length > 0;
  material.clippingPlanes = clippingPlanes;
  if (hadClipping !== hasClipping) material.needsUpdate = true;
}

function createFaceOverlayGeometry(mesh: ReplicadMesh, faceId: number): THREE.BufferGeometry | null {
  const group = mesh.faceGroups?.find((candidate) => candidate.faceId === faceId);
  if (!group) return null;
  const positions: number[] = [];
  const end = Math.min(group.start + group.count, mesh.triangles.length);
  for (let offset = group.start; offset < end; offset += 1) {
    const vertexOffset = mesh.triangles[offset] * 3;
    if (vertexOffset < 0 || vertexOffset + 2 >= mesh.vertices.length) continue;
    positions.push(
      mesh.vertices[vertexOffset],
      mesh.vertices[vertexOffset + 1],
      mesh.vertices[vertexOffset + 2]
    );
  }
  if (positions.length < 9) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function selectionDimensions(selection: ReplicadSelection): string {
  const values = (selection.face?.boundingBox.size ?? selection.shapeBoundingBox.size)
    .filter((value) => value > 1e-6)
    .map((value) => formatNumber(value));
  return `${values.length ? values.join(' × ') : '0'} mm`;
}

interface DecomposedFrame {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
}

interface PreviewHandles {
  capture: () => Promise<string | null>;
  captureViews: (views: ViewName[]) => Promise<Partial<Record<ViewName, string>>>;
}

interface PreviewPaneProps {
  modelFilePath: string;
  storage: ExtensionStorage;
  shapes: ShapeResult[];
  animation?: AnimationData;
  wireframe: boolean;
  theme: string;
  playing: boolean;
  /** When paused, the normalized time [0,1) to display; ignored while playing. */
  scrubT: number | null;
  onTimeUpdate?: (t: number) => void;
  selection: ReplicadSelection | null;
  shapeVisibility: ShapeVisibility;
  onSelectionChange: (selection: ReplicadSelection | null) => void;
  onReady: (handles: PreviewHandles) => void;
}

function PreviewPane({
  modelFilePath,
  storage,
  shapes,
  animation,
  wireframe,
  theme,
  playing,
  scrubT,
  onTimeUpdate,
  selection,
  shapeVisibility,
  onSelectionChange,
  onReady,
}: PreviewPaneProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<PreviewCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const shapeGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const shapeMeshesRef = useRef<Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>>(new Map());
  const tracksRef = useRef<Map<string, DecomposedFrame[]>>(new Map());
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const radiusRef = useRef<number>(50);
  const centerRef = useRef<THREE.Vector3>(new THREE.Vector3());
  const tRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const cameraPersistenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraPersistenceEnabledRef = useRef(false);
  const [initialCameraState] = useState<PersistedCameraState | null>(() =>
    readPersistedCamera(storage, modelFilePath)
  );
  const initialCameraAppliedRef = useRef(false);
  const cameraActionsRef = useRef<{
    setView: (view: ViewName) => void;
    fit: () => void;
    setProjection: (mode: ProjectionMode) => void;
    restore: (state: PersistedCameraState) => void;
  } | null>(null);
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>('perspective');
  const highlightRef = useRef<{
    owner: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null;
    overlay: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null;
  }>({ owner: null, overlay: null });
  // Scratch objects reused every frame to avoid per-frame allocation.
  const tmp = useRef({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3() });
  // The parent passes a fresh onReady closure every render; hold it in a ref so the
  // init effect below can run exactly once (mount) instead of tearing down and
  // rebuilding the whole WebGL scene on every parent re-render — which left a fresh,
  // empty scene that only repopulated when a shapes-effect dep (e.g. wireframe)
  // changed, hence "blank until I toggle wireframe".
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const modelFilePathRef = useRef(modelFilePath);
  modelFilePathRef.current = modelFilePath;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const shapeVisibilityRef = useRef(shapeVisibility);
  shapeVisibilityRef.current = shapeVisibility;
  const sectionRanges = useMemo(
    () => modelAxisRanges(shapes.map((shape) => shape.mesh)),
    [shapes]
  );
  const [sectionAxis, setSectionAxis] = useState<SectionAxis>('z');
  const [sectionFlip, setSectionFlip] = useState(false);
  const [sectionEnabled, setSectionEnabled] = useState(false);
  const [sectionOffsetMm, setSectionOffsetMm] = useState(
    () => (sectionRanges.z.min + sectionRanges.z.max) / 2
  );
  const sectionRange = sectionRanges[sectionAxis];
  const sectionPlane = useMemo(
    () =>
      sectionEnabled
        ? createWorldSectionPlane({ axis: sectionAxis, offsetMm: sectionOffsetMm, flip: sectionFlip })
        : null,
    [sectionAxis, sectionEnabled, sectionFlip, sectionOffsetMm]
  );
  const activeClippingPlanes = useMemo(() => (sectionPlane ? [sectionPlane] : []), [sectionPlane]);
  const sectionPlaneRef = useRef<THREE.Plane | null>(sectionPlane);
  sectionPlaneRef.current = sectionPlane;
  const clippingPlanesRef = useRef<THREE.Plane[]>(activeClippingPlanes);
  clippingPlanesRef.current = activeClippingPlanes;

  const renderScene = useCallback(() => {
    if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;
    rendererRef.current.render(sceneRef.current, cameraRef.current);
  }, []);

  useEffect(() => {
    setSectionOffsetMm((current) => clampToAxisRange(current, sectionRanges[sectionAxis]));
  }, [sectionAxis, sectionRanges]);

  useEffect(() => {
    for (const mesh of shapeMeshesRef.current.values()) {
      setMaterialClippingPlanes(mesh.material, activeClippingPlanes);
    }
    const overlay = highlightRef.current.overlay;
    if (overlay) setMaterialClippingPlanes(overlay.material, activeClippingPlanes);
    renderScene();
  }, [activeClippingPlanes, renderScene]);

  const writeCameraState = useCallback(() => {
    if (!cameraPersistenceEnabledRef.current) return;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const state: PersistedCameraState = {
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      up: camera.up.toArray() as [number, number, number],
      projection: camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective',
      ...(camera instanceof THREE.OrthographicCamera
        ? { zoom: camera.zoom, orthographicHeight: camera.top - camera.bottom }
        : {}),
    };
    void storage.set(cameraStorageKey(modelFilePath), state).catch((error: unknown) => {
      console.warn('[Cutu CAD] Failed to persist preview camera:', getErrorMessage(error));
    });
  }, [modelFilePath, storage]);

  const persistCamera = useCallback(() => {
    if (!cameraPersistenceEnabledRef.current) return;
    if (cameraPersistenceTimerRef.current) clearTimeout(cameraPersistenceTimerRef.current);
    cameraPersistenceTimerRef.current = setTimeout(() => {
      cameraPersistenceTimerRef.current = null;
      writeCameraState();
    }, CAMERA_PERSIST_DEBOUNCE_MS);
  }, [writeCameraState]);

  const clearSelectionHighlight = useCallback(() => {
    const { owner, overlay } = highlightRef.current;
    if (owner) {
      owner.material.emissive.set('#000000');
      owner.material.emissiveIntensity = 0;
    }
    if (overlay) {
      overlay.removeFromParent();
      overlay.geometry.dispose();
      overlay.material.dispose();
    }
    highlightRef.current = { owner: null, overlay: null };
  }, []);

  const applySelectionHighlight = useCallback(
    (nextSelection: ReplicadSelection | null) => {
      clearSelectionHighlight();
      if (!nextSelection) {
        renderScene();
        return;
      }
      const owner = shapeMeshesRef.current.get(nextSelection.shapeName);
      const group = shapeGroupsRef.current.get(nextSelection.shapeName);
      const shape = shapesRef.current.find((candidate) => candidate.name === nextSelection.shapeName);
      if (!owner || !group || !shape) return;

      owner.material.emissive.set(SELECTION_ACCENT);
      owner.material.emissiveIntensity = 0.2;
      let overlay: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
      if (nextSelection.face) {
        const overlayGeometry = createFaceOverlayGeometry(shape.mesh, nextSelection.face.id);
        if (overlayGeometry) {
          const overlayMaterial = new THREE.MeshStandardMaterial({
            color: SELECTION_ACCENT,
            emissive: SELECTION_ACCENT,
            emissiveIntensity: 0.25,
            transparent: true,
            opacity: 0.72,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            clippingPlanes: clippingPlanesRef.current,
          });
          overlay = new THREE.Mesh(overlayGeometry, overlayMaterial);
          overlay.frustumCulled = false;
          overlay.renderOrder = 1;
          group.add(overlay);
        }
      }
      highlightRef.current = { owner, overlay };
      renderScene();
    },
    [clearSelectionHighlight, renderScene]
  );

  // Pose every shape group for normalized time t, interpolating between the two
  // bracketing track frames (lerp position/scale, slerp rotation) for smoothness
  // independent of the sample rate. Shapes with no track stay at identity (rest).
  const applyFrame = useCallback(
    (t: number) => {
      const groups = shapeGroupsRef.current;
      const tracks = tracksRef.current;
      const loop = animation?.loop ?? true;
      const scratch = tmp.current;
      for (const [name, group] of groups) {
        const track = tracks.get(name);
        if (!track || track.length === 0) {
          group.matrix.identity();
          group.matrixWorldNeedsUpdate = true;
          continue;
        }
        const frames = track.length;
        const x = t * (loop ? frames : frames - 1);
        let i0 = Math.floor(x);
        let i1: number;
        let a = x - i0;
        if (loop) {
          i0 = ((i0 % frames) + frames) % frames;
          i1 = (i0 + 1) % frames;
        } else {
          i0 = Math.min(Math.max(i0, 0), frames - 1);
          i1 = Math.min(i0 + 1, frames - 1);
          if (i0 === frames - 1) a = 0;
        }
        const A = track[i0];
        const B = track[i1];
        scratch.pos.lerpVectors(A.pos, B.pos, a);
        scratch.quat.copy(A.quat).slerp(B.quat, a);
        scratch.scale.lerpVectors(A.scale, B.scale, a);
        group.matrix.compose(scratch.pos, scratch.quat, scratch.scale);
        group.matrixWorldNeedsUpdate = true;
      }
      renderScene();
    },
    [animation, renderScene]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = readPreviewThemeColors('replicad-editor');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.background);

    const camera = new THREE.PerspectiveCamera(PERSPECTIVE_FOV_DEG, 1, 0.1, 100000);
    camera.position.set(110, 90, 110);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    const handleControlsChange = () => {
      renderScene();
      persistCamera();
    };
    const createControls = (nextCamera: PreviewCamera, target?: THREE.Vector3): OrbitControls => {
      const nextControls = new OrbitControls(nextCamera, renderer.domElement);
      nextControls.enableDamping = false;
      if (target) nextControls.target.copy(target);
      nextControls.addEventListener('change', handleControlsChange);
      return nextControls;
    };
    const controls = createControls(camera);

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      if (!start || start.pointerId !== event.pointerId || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > PICK_MOVEMENT_THRESHOLD_PX) return;

      const bounds = renderer.domElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      const activeCamera = cameraRef.current;
      if (!activeCamera) return;
      raycaster.setFromCamera(pointer, activeCamera);
      modelGroup.updateMatrixWorld(true);
      const activeSectionPlane = sectionPlaneRef.current;
      const hit = raycaster
        .intersectObjects(
          [...shapeMeshesRef.current.entries()]
            .filter(([shapeName]) => isShapeVisible(shapeVisibilityRef.current, shapeName))
            .map(([, mesh]) => mesh),
          false
        )
        .find(
          (intersection) =>
            !activeSectionPlane ||
            activeSectionPlane.distanceToPoint(intersection.point) >= -SECTION_PICK_EPSILON_MM
        );
      if (!hit) {
        onSelectionChangeRef.current(null);
        return;
      }
      const shapeName = hit.object.userData.shapeName as string | undefined;
      const shape = shapesRef.current.find((candidate) => candidate.name === shapeName);
      if (!shape) {
        onSelectionChangeRef.current(null);
        return;
      }
      // Remove only the modelGroup's -90deg X rotation. The resulting point is
      // expressed in the model's Z-up coordinates (including the current pose).
      const modelPoint = modelGroup.worldToLocal(hit.point.clone());
      onSelectionChangeRef.current(
        buildReplicadSelection(
          modelFilePathRef.current,
          shape,
          hit.faceIndex ?? null,
          [modelPoint.x, modelPoint.y, modelPoint.z]
        )
      );
    };
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

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

    // Z-up -> Y-up axis swap lives on the parent; children (per-shape groups)
    // carry model-space animation matrices.
    const modelGroup = new THREE.Group();
    modelGroup.rotateX(-Math.PI / 2);
    scene.add(modelGroup);
    modelGroupRef.current = modelGroup;

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    const resizeObserver = new ResizeObserver(() => {
      if (!container || !rendererRef.current || !cameraRef.current) return;
      const safeWidth = Math.max(container.clientWidth, 1);
      const safeHeight = Math.max(container.clientHeight, 1);
      rendererRef.current.setSize(safeWidth, safeHeight);
      updateCameraForViewport(cameraRef.current, safeWidth, safeHeight);
      renderScene();
    });
    resizeObserver.observe(container);

    const currentAspect = () => Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1);
    const replaceControls = (nextCamera: PreviewCamera, target: THREE.Vector3) => {
      const previousControls = controlsRef.current;
      if (previousControls) {
        previousControls.removeEventListener('change', handleControlsChange);
        previousControls.dispose();
      }
      cameraRef.current = nextCamera;
      controlsRef.current = createControls(nextCamera, target);
    };
    const setProjection = (mode: ProjectionMode) => {
      const activeCamera = cameraRef.current;
      const activeControls = controlsRef.current;
      if (!activeCamera || !activeControls) return;
      const isOrthographic = activeCamera instanceof THREE.OrthographicCamera;
      if ((mode === 'orthographic') === isOrthographic) return;

      const target = activeControls.target.clone();
      const direction = activeCamera.position.clone().sub(target);
      const distance = Math.max(direction.length(), 0.01);
      if (direction.lengthSq() > 1e-8) direction.normalize();
      else direction.copy(viewDirection('iso'));
      const aspect = currentAspect();
      let nextCamera: PreviewCamera;
      if (mode === 'orthographic') {
        const perspective = activeCamera as THREE.PerspectiveCamera;
        const visibleHeight =
          (2 * distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2))) / perspective.zoom;
        nextCamera = new THREE.OrthographicCamera(
          (-visibleHeight * aspect) / 2,
          (visibleHeight * aspect) / 2,
          visibleHeight / 2,
          -visibleHeight / 2,
          activeCamera.near,
          activeCamera.far
        );
        nextCamera.position.copy(activeCamera.position);
      } else {
        const orthographic = activeCamera as THREE.OrthographicCamera;
        const visibleHeight = (orthographic.top - orthographic.bottom) / orthographic.zoom;
        const perspectiveDistance =
          visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(PERSPECTIVE_FOV_DEG / 2)));
        nextCamera = new THREE.PerspectiveCamera(
          PERSPECTIVE_FOV_DEG,
          aspect,
          activeCamera.near,
          activeCamera.far
        );
        nextCamera.position.copy(target).addScaledVector(direction, perspectiveDistance);
      }
      nextCamera.up.copy(activeCamera.up);
      nextCamera.lookAt(target);
      nextCamera.updateProjectionMatrix();
      replaceControls(nextCamera, target);
      setProjectionMode(mode);
      controlsRef.current?.update();
      renderScene();
      persistCamera();
    };
    const fitCurrentView = () => {
      const activeCamera = cameraRef.current;
      const activeControls = controlsRef.current;
      if (!activeCamera || !activeControls) return;
      const direction = activeCamera.position.clone().sub(activeControls.target);
      fitCameraToSphere(activeCamera, centerRef.current, radiusRef.current, direction, currentAspect());
      activeControls.target.copy(centerRef.current);
      activeControls.update();
      renderScene();
      persistCamera();
    };
    const setView = (view: ViewName) => {
      const activeCamera = cameraRef.current;
      const activeControls = controlsRef.current;
      if (!activeCamera || !activeControls) return;
      placeCameraForView(activeCamera, centerRef.current, Math.max(radiusRef.current * 3, 48), view);
      const direction = activeCamera.position.clone().sub(centerRef.current);
      fitCameraToSphere(activeCamera, centerRef.current, radiusRef.current, direction, currentAspect());
      activeControls.target.copy(centerRef.current);
      activeControls.update();
      renderScene();
      persistCamera();
    };
    const restore = (state: PersistedCameraState) => {
      setProjection(state.projection);
      const activeCamera = cameraRef.current;
      const activeControls = controlsRef.current;
      if (!activeCamera || !activeControls) return;
      activeCamera.position.fromArray(state.position);
      activeCamera.up.fromArray(state.up ?? [0, 1, 0]);
      if (activeCamera instanceof THREE.OrthographicCamera) {
        const aspect = currentAspect();
        const distance = activeCamera.position.distanceTo(new THREE.Vector3(...state.target));
        const height =
          state.orthographicHeight ??
          2 * Math.max(distance, 0.01) * Math.tan(THREE.MathUtils.degToRad(PERSPECTIVE_FOV_DEG / 2));
        activeCamera.top = height / 2;
        activeCamera.bottom = -height / 2;
        activeCamera.left = (-height * aspect) / 2;
        activeCamera.right = (height * aspect) / 2;
        activeCamera.zoom = state.zoom ?? 1;
      }
      activeControls.target.fromArray(state.target);
      const distance = Math.max(activeCamera.position.distanceTo(activeControls.target), radiusRef.current);
      activeCamera.near = Math.max(distance / 1000, 0.01);
      activeCamera.far = Math.max(distance * 40, radiusRef.current * 40);
      activeCamera.lookAt(activeControls.target);
      activeCamera.updateProjectionMatrix();
      activeControls.update();
      renderScene();
    };
    cameraActionsRef.current = { setView, fit: fitCurrentView, setProjection, restore };

    const captureViews = async (views: ViewName[]): Promise<Partial<Record<ViewName, string>>> => {
      const out: Partial<Record<ViewName, string>> = {};
      const activeCamera = cameraRef.current;
      if (!activeCamera) return out;
      const center = centerRef.current;
      const distance = Math.max(radiusRef.current * 2.6, 40);
      const camera2 = new THREE.PerspectiveCamera(
        PERSPECTIVE_FOV_DEG,
        currentAspect(),
        activeCamera.near,
        activeCamera.far
      );
      const previousVisibility = new Map<string, boolean>();
      for (const [shapeName, group] of shapeGroupsRef.current) {
        previousVisibility.set(shapeName, group.visible);
        group.visible = true;
      }
      try {
        for (const view of views) {
          // Preserve the existing capture distance, including its longer diagonal
          // offset for the isometric direction, while sharing view placement math.
          const legacyDistance = distance * new THREE.Vector3(...VIEW_DIRECTIONS[view]).length();
          placeCameraForView(camera2, center, legacyDistance, view);
          camera2.updateProjectionMatrix();
          renderer.render(scene, camera2);
          out[view] = renderer.domElement.toDataURL('image/png');
        }
      } finally {
        for (const [shapeName, group] of shapeGroupsRef.current) {
          group.visible = previousVisibility.get(shapeName) ?? true;
        }
        renderScene();
      }
      return out;
    };

    onReadyRef.current({
      capture: async () => renderer.domElement.toDataURL('image/png'),
      captureViews,
    });
    renderScene();

    return () => {
      resizeObserver.disconnect();
      if (cameraPersistenceTimerRef.current) clearTimeout(cameraPersistenceTimerRef.current);
      cameraPersistenceTimerRef.current = null;
      writeCameraState();
      cameraPersistenceEnabledRef.current = false;
      cameraActionsRef.current = null;
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      const activeControls = controlsRef.current;
      activeControls?.removeEventListener('change', handleControlsChange);
      activeControls?.dispose();
      clearSelectionHighlight();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      modelGroupRef.current = null;
      shapeGroupsRef.current.clear();
      shapeMeshesRef.current.clear();
      gridRef.current = null;
    };
    // Init once on mount: renderScene is stable (useCallback []) and onReady is read
    // through onReadyRef, so the renderer/scene is never rebuilt on parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSelectionHighlight, persistCamera, renderScene, writeCameraState]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const colors = readPreviewThemeColors('replicad-editor');
    scene.background = new THREE.Color(colors.background);
    if (gridRef.current) {
      scene.remove(gridRef.current);
      const replacement = new THREE.GridHelper(240, 24, colors.gridB, colors.gridA);
      scene.add(replacement);
      gridRef.current = replacement;
    }
    renderScene();
  }, [theme, renderScene]);

  // Rebuild per-shape groups and decompose animation tracks when shapes change.
  useEffect(() => {
    const modelGroup = modelGroupRef.current;
    if (!modelGroup || !cameraRef.current || !controlsRef.current) return;

    clearSelectionHighlight();
    for (const group of shapeGroupsRef.current.values()) {
      for (const child of group.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material | undefined)?.dispose?.();
      }
      modelGroup.remove(group);
    }
    shapeGroupsRef.current.clear();
    shapeMeshesRef.current.clear();
    tracksRef.current.clear();

    if (shapes.length === 0) {
      renderScene();
      return;
    }

    const colors = readPreviewThemeColors('replicad-editor');
    for (const shape of shapes) {
      if (!shape.mesh.vertices.length) continue;
      // Model-space geometry (no per-geometry rotation; the parent handles Y-up).
      const geometry = replicadMeshToGeometry(shape.mesh);
      const material = new THREE.MeshStandardMaterial({
        color: shape.color ?? colors.mesh,
        metalness: 0.05,
        roughness: 0.7,
        wireframe,
        transparent: shape.opacity !== undefined && shape.opacity < 1,
        opacity: shape.opacity ?? 1,
        side: THREE.DoubleSide,
        clippingPlanes: clippingPlanesRef.current,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.userData.shapeName = shape.name;
      const group = new THREE.Group();
      group.matrixAutoUpdate = false; // we set group.matrix directly for animation
      group.visible = isShapeVisible(shapeVisibility, shape.name);
      group.add(mesh);
      modelGroup.add(group);
      shapeGroupsRef.current.set(shape.name, group);
      shapeMeshesRef.current.set(shape.name, mesh);
    }

    // Decompose animation matrices into TRS keyframes for interpolation.
    if (animation) {
      for (const [name, frames] of Object.entries(animation.tracks)) {
        const decomposed: DecomposedFrame[] = frames.map((flat) => {
          const m = new THREE.Matrix4().fromArray(flat);
          const pos = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          m.decompose(pos, quat, scale);
          return { pos, quat, scale };
        });
        tracksRef.current.set(name, decomposed);
      }
    }

    // Pose to rest (t=0 == identity) and frame the camera on the world bbox.
    tRef.current = 0;
    applyFrame(0);
    modelGroup.updateMatrixWorld(true);
    const overall = new THREE.Box3().setFromObject(modelGroup);
    const center = new THREE.Vector3();
    overall.getCenter(center);
    const sphere = new THREE.Sphere();
    overall.getBoundingSphere(sphere);
    const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 50;
    centerRef.current.copy(center);
    radiusRef.current = radius;

    if (!initialCameraAppliedRef.current) {
      initialCameraAppliedRef.current = true;
      const persisted = initialCameraState;
      if (persisted) {
        cameraActionsRef.current?.restore(persisted);
      } else {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const distance = Math.max(radius * 2.6, 48);
        camera.near = Math.max(distance / 100, 0.1);
        camera.far = distance * 40;
        camera.position.set(center.x + distance, center.y + distance * 0.72, center.z + distance);
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();
      }
      cameraPersistenceEnabledRef.current = true;
    } else {
      cameraActionsRef.current?.setView('iso');
    }
    applySelectionHighlight(selectionRef.current);
    renderScene();
  }, [
    shapes,
    animation,
    wireframe,
    initialCameraState,
    applyFrame,
    applySelectionHighlight,
    clearSelectionHighlight,
    renderScene,
  ]);

  useEffect(() => {
    for (const [shapeName, group] of shapeGroupsRef.current) {
      group.visible = isShapeVisible(shapeVisibility, shapeName);
    }
    renderScene();
  }, [shapeVisibility, renderScene]);

  useEffect(() => {
    applySelectionHighlight(selection);
  }, [selection, applySelectionHighlight]);

  // Playback / scrub.
  useEffect(() => {
    if (!animation) return;
    if (!playing) {
      const t = scrubT ?? tRef.current;
      tRef.current = t;
      applyFrame(t);
      return;
    }
    const durationMs = animation.durationMs;
    lastTsRef.current = null;
    const tick = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = ts - lastTsRef.current;
      lastTsRef.current = ts;
      let t = tRef.current + dt / durationMs;
      if (animation.loop) t -= Math.floor(t);
      else t = Math.min(1, t);
      tRef.current = t;
      applyFrame(t);
      onTimeUpdate?.(t);
      if (!animation.loop && t >= 1) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [animation, playing, scrubT, applyFrame, onTimeUpdate]);

  return (
    <>
      <ContextMenu trigger={<div ref={containerRef} className="replicad-preview-canvas" tabIndex={0} aria-label="Model canvas" />}>
        <MenuItem onClick={() => cameraActionsRef.current?.fit()}>Fit model to view</MenuItem>
        {(['iso', 'top', 'front', 'right'] as const).map((view) => (
          <MenuItem key={view} onClick={() => cameraActionsRef.current?.setView(view)}>{view[0].toUpperCase() + view.slice(1)} view</MenuItem>
        ))}
        <MenuItem onClick={() => setSectionEnabled((enabled) => !enabled)}>{sectionEnabled ? 'Hide section plane' : 'Section plane'}</MenuItem>
        <MenuItem onClick={() => onSelectionChange(null)}>Clear geometry selection</MenuItem>
      </ContextMenu>
      <div className="replicad-view-controls" role="group" aria-label="3D preview view controls">
        <Tooltip content="Fit model to view">
          <Button variant="ghost" size="sm" onClick={() => cameraActionsRef.current?.fit()}>Fit</Button>
        </Tooltip>
        <Menu triggerLabel="Model view" trigger={(props) => <Button {...props} variant="ghost" size="sm">View</Button>}>
          {(['iso', 'top', 'front', 'right'] as const).map((view) => (
            <MenuItem key={view} onClick={() => cameraActionsRef.current?.setView(view)}>{view[0].toUpperCase() + view.slice(1)} view</MenuItem>
          ))}
          <MenuItem onClick={() => setSectionEnabled((enabled) => !enabled)}>{sectionEnabled ? 'Hide section plane' : 'Section plane'}</MenuItem>
          <MenuItem onClick={() => cameraActionsRef.current?.setProjection(projectionMode === 'perspective' ? 'orthographic' : 'perspective')}>
            {projectionMode === 'perspective' ? 'Orthographic projection' : 'Perspective projection'}
          </MenuItem>
        </Menu>
      </div>
      {sectionEnabled ? (
        <div className="replicad-section-panel" role="group" aria-label="Section plane controls">
          <div className="replicad-section-header">
            <strong>Section plane</strong>
            <button type="button" title="Disable section plane" onClick={() => setSectionEnabled(false)}>
              Close
            </button>
          </div>
          <div className="replicad-section-row">
            <span>Axis</span>
            <div className="replicad-section-axis" role="group" aria-label="Model-space section axis">
              {(['x', 'y', 'z'] as const).map((axis) => (
                <button
                  key={axis}
                  type="button"
                  aria-pressed={sectionAxis === axis}
                  title={`Use model-space ${axis.toUpperCase()} axis`}
                  onClick={() => {
                    setSectionAxis(axis);
                    setSectionOffsetMm((current) => clampToAxisRange(current, sectionRanges[axis]));
                  }}
                >
                  {axis.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="replicad-section-flip"
              aria-pressed={sectionFlip}
              title="Reverse the visible side of the section plane"
              onClick={() => setSectionFlip((flipped) => !flipped)}
            >
              Flip
            </button>
          </div>
          <label className="replicad-section-slider">
            <span>Offset</span>
            <input
              type="range"
              min={sectionRange.min}
              max={sectionRange.max}
              step={sectionRange.max > sectionRange.min ? (sectionRange.max - sectionRange.min) / 200 : 1}
              value={sectionOffsetMm}
              disabled={sectionRange.max <= sectionRange.min}
              aria-label={`Section offset on model-space ${sectionAxis.toUpperCase()} axis in millimeters`}
              onChange={(event) => setSectionOffsetMm(Number(event.currentTarget.value))}
            />
            <output>{formatNumber(sectionOffsetMm)} mm</output>
          </label>
        </div>
      ) : null}
    </>
  );
}

function initialValuesFromDefs(defs: ParamDef[], previous: ParamValues): ParamValues {
  const values: ParamValues = {};
  for (const def of defs) {
    values[def.name] = def.name in previous ? previous[def.name] : def.default;
  }
  return values;
}

interface TimelineProps {
  playing: boolean;
  durationMs: number;
  onTogglePlay: () => void;
  onScrub: (t: number) => void;
  /** PreviewPane pushes live playback time here to move the scrubber without re-rendering. */
  bindProgress: (setter: (t: number) => void) => void;
}

function Timeline({ playing, durationMs, onTogglePlay, onScrub, bindProgress }: TimelineProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    bindProgress((t) => {
      const input = inputRef.current;
      if (input && document.activeElement !== input) input.value = String(t);
    });
  }, [bindProgress]);
  return (
    <div className="replicad-timeline">
      <button type="button" className="replicad-timeline-play" onClick={onTogglePlay} aria-pressed={playing}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={1}
        step={0.001}
        defaultValue={0}
        onChange={(event) => onScrub(Number(event.currentTarget.value))}
      />
      <span className="replicad-timeline-time">{(durationMs / 1000).toFixed(1)}s loop</span>
    </div>
  );
}

interface ShapeTreePanelProps {
  shapes: ShapeResult[];
  visibility: ShapeVisibility;
  selection: ReplicadSelection | null;
  onSelect: (shape: ShapeResult) => void;
  onToggleVisibility: (shapeName: string) => void;
  onSolo: (shapeName: string) => void;
}

function ShapeTreePanel({
  shapes,
  visibility,
  selection,
  onSelect,
  onToggleVisibility,
  onSolo,
}: ShapeTreePanelProps): React.ReactElement {
  return (
    <section className="replicad-shapes" aria-label="Shapes">
      <div className="replicad-shapes-title">
        Shapes
      </div>
      <div className="replicad-shape-list">
        {shapes.map((shape) => {
          const isVisible = isShapeVisible(visibility, shape.name);
          const isSelected = selection?.shapeName === shape.name;
          const isSolo = isVisible && shapes.every(
            (candidate) => candidate.name === shape.name || !isShapeVisible(visibility, candidate.name)
          );
          return (
            <div
              key={shape.name}
              className={`replicad-shape-row${isSelected ? ' replicad-shape-row--selected' : ''}`}
            >
              <button
                type="button"
                className="replicad-shape-row-main"
                title={`Select ${shape.name}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(shape)}
              >
                <span
                  className="replicad-shape-swatch"
                  style={{ backgroundColor: shape.color ?? 'var(--cutucircuits-border-focus, #3b82f6)' }}
                  aria-hidden="true"
                />
                <span className="replicad-shape-name">{shape.name}</span>
              </button>
              <button
                type="button"
                className="replicad-shape-visibility"
                title={isVisible ? `Hide ${shape.name}` : `Show ${shape.name}`}
                aria-label={isVisible ? `Hide ${shape.name}` : `Show ${shape.name}`}
                aria-pressed={isVisible}
                onClick={() => onToggleVisibility(shape.name)}
              >
                <span
                  className={`replicad-visibility-eye${isVisible ? '' : ' replicad-visibility-eye--hidden'}`}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="replicad-shape-solo"
                title={isSolo ? 'Show all shapes' : `Show only ${shape.name}`}
                aria-pressed={isSolo}
                onClick={() => onSolo(shape.name)}
              >
                Solo
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Resizable / collapsible / persistent pane layout -----------------------
// The editor is a nested flexbox: an outer track (code+preview "main" | params)
// and an inner "main" track (code | preview). Container queries flip the flex
// directions as the tab narrows — main stacks below 620px, params drops beneath
// main below 1000px — so the same panes reflow from three columns to a vertical
// stack. Each side pane stores BOTH an along-row width and an along-column
// height; CSS custom properties let the stylesheet pick whichever the current
// orientation needs. A resizer discovers its axis from its parent's live
// flex-direction, so one component handles both horizontal and vertical drags.
// Sizes and collapse state persist to localStorage, shared across every
// *.replicad.ts tab.

const LAYOUT_STORAGE_KEY = 'com.cutucircuits.replicad.layout.v3';
const MIN_PANE = 140; // smallest a resizable pane may be dragged to
const MIN_REST = 180; // room the rest of the track must keep

interface LayoutState {
  codeW: number; // code width when main is a row (wide/medium)
  codeH: number; // code height when main is a column (narrow)
  paramsW: number; // params width when the outer track is a row (wide)
  paramsH: number; // params height when the outer track is a column (medium/narrow)
  codeCollapsed: boolean;
  paramsCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
  codeW: 440,
  codeH: 280,
  paramsW: 260,
  paramsH: 220,
  codeCollapsed: true,
  paramsCollapsed: true,
};

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

function loadLayout(): LayoutState {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      codeW: num(parsed.codeW, DEFAULT_LAYOUT.codeW),
      codeH: num(parsed.codeH, DEFAULT_LAYOUT.codeH),
      paramsW: num(parsed.paramsW, DEFAULT_LAYOUT.paramsW),
      paramsH: num(parsed.paramsH, DEFAULT_LAYOUT.paramsH),
      codeCollapsed: parsed.codeCollapsed ?? DEFAULT_LAYOUT.codeCollapsed,
      paramsCollapsed: parsed.paramsCollapsed ?? DEFAULT_LAYOUT.paramsCollapsed,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

interface ResizerProps {
  /** Which pane this divider sizes; also drives the CSS cursor/grip orientation. */
  target: 'code' | 'params';
  /** When the controlled pane is collapsed the divider is inert (drag disabled). */
  disabled: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}

function Resizer({ target, disabled, onPointerDown, onPointerMove, onPointerUp }: ResizerProps): React.ReactElement {
  return (
    <div
      className={`replicad-resizer replicad-resizer--${target}${disabled ? ' replicad-resizer--disabled' : ''}`}
      role="separator"
      onPointerDown={disabled ? undefined : onPointerDown}
      onPointerMove={disabled ? undefined : onPointerMove}
      onPointerUp={disabled ? undefined : onPointerUp}
    />
  );
}

export function createReplicadProjectEditor(extensionContext: ExtensionContext) {
  return function ReplicadProjectEditor({ host }: EditorHostProps): React.ReactElement {
    const filesystem = extensionContext.services.filesystem;
    const ui = extensionContext.services.ui;
    const configuration = extensionContext.services.configuration;
    const extensionPath = extensionContext.extensionPath;
    const isTabActive = host.isActive ?? true;
    const compileDebounceMs = configuration?.get<number>('compileDebounceMs', 600) ?? 600;

    const environment = useMemo(() => ({ filesystem, extensionPath }), [filesystem, extensionPath]);

    // The editor is bound to a single open tab. The file in that tab *is* the
    // model — every *.replicad.ts is a self-contained model — so there is no
    // root/model picker; we always compile host.filePath. The project graph is
    // still indexed, but only to resolve imported STEP assets for the compile.
    const [workspacePath, setWorkspacePath] = useState<string | null>(null);
    const [projectGraph, setProjectGraph] = useState<ReplicadProjectGraph | null>(null);
    // Workspace conventions (printer bed/nozzle, units) seed the in-editor
    // printability check. Stored separately because the graph state holds only the
    // module/asset graph, not the conventions.
    const [conventions, setConventions] = useState<ReplicadConventions | null>(null);
    const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
    // The last compile that produced geometry. Kept so a transient compile error
    // (a typo mid-edit) shows the previous good model dimmed instead of blanking the
    // viewport — which also avoids tearing down and rebuilding the WebGL context and
    // resetting the camera on every error/fix cycle.
    const [lastGoodResult, setLastGoodResult] = useState<CompileResult | null>(null);
    const [paramDefs, setParamDefs] = useState<ParamDef[]>([]);
    const [paramValues, setParamValues] = useState<ParamValues>({});
    const [isCompiling, setIsCompiling] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
    const [projectError, setProjectError] = useState<string | null>(null);
    const [wireframe, setWireframe] = useState(false);
    const [theme, setTheme] = useState<string>(host.theme);
    const [isPlaying, setIsPlaying] = useState(true);
    const [scrubT, setScrubT] = useState<number | null>(null);
    const [selection, setSelection] = useState<ReplicadSelection | null>(null);
    const [shapeVisibility, setShapeVisibility] = useState<ShapeVisibility>({});

    // Resizable / collapsible / persistent pane layout.
    const [layout, setLayout] = useState<LayoutState>(loadLayout);
    const [inspector, setInspector] = useState<'params' | 'parts'>('params');
    const toggleInspector = (next: 'params' | 'parts') => {
      setInspector(next);
      setLayout((previous) => ({
        ...previous,
        paramsCollapsed: inspector === next ? !previous.paramsCollapsed : false,
      }));
    };
    const layoutRef = useRef<HTMLDivElement | null>(null);
    // Captured at pointer-down: the drag axis is read from the divider's parent
    // flex-direction so the same handler resizes a width (row) or a height
    // (column) depending on how the panes are currently reflowed.
    const dragRef = useRef<{
      target: 'code' | 'params';
      axis: 'x' | 'y';
      start: number;
      startSize: number;
      containerSize: number;
    } | null>(null);

    useEffect(() => {
      try {
        window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
      } catch {
        // ignore quota / privacy-mode failures; layout just won't persist
      }
    }, [layout]);

    const beginResize = useCallback(
      (target: 'code' | 'params') => (event: React.PointerEvent<HTMLDivElement>) => {
        const parent = event.currentTarget.parentElement;
        if (!parent) return;
        const axis: 'x' | 'y' = getComputedStyle(parent).flexDirection.startsWith('column') ? 'y' : 'x';
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const startSize =
          axis === 'x'
            ? target === 'code'
              ? layout.codeW
              : layout.paramsW
            : target === 'code'
              ? layout.codeH
              : layout.paramsH;
        dragRef.current = {
          target,
          axis,
          start: axis === 'x' ? event.clientX : event.clientY,
          startSize,
          containerSize: axis === 'x' ? parent.clientWidth : parent.clientHeight,
        };
      },
      [layout.codeW, layout.codeH, layout.paramsW, layout.paramsH]
    );

    const onResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = (drag.axis === 'x' ? event.clientX : event.clientY) - drag.start;
      // Code grows as the divider moves away from its origin; params (past the
      // preview) grows as the divider moves back toward it — hence the sign flip.
      const raw = drag.target === 'code' ? drag.startSize + delta : drag.startSize - delta;
      const size = clamp(raw, MIN_PANE, drag.containerSize - MIN_REST);
      setLayout((prev) => {
        if (drag.target === 'code') return drag.axis === 'x' ? { ...prev, codeW: size } : { ...prev, codeH: size };
        return drag.axis === 'x' ? { ...prev, paramsW: size } : { ...prev, paramsH: size };
      });
    }, []);

    const endResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer may already be released
      }
    }, []);

    const toggleCollapse = useCallback((which: 'code' | 'params') => {
      setLayout((prev) =>
        which === 'code'
          ? { ...prev, codeCollapsed: !prev.codeCollapsed }
          : { ...prev, paramsCollapsed: !prev.paramsCollapsed }
      );
    }, []);

    const layoutVars = {
      '--code-w': `${layout.codeW}px`,
      '--code-h': `${layout.codeH}px`,
      '--params-w': `${layout.paramsW}px`,
      '--params-h': `${layout.paramsH}px`,
    } as React.CSSProperties;

    const progressSetterRef = useRef<(t: number) => void>(() => {});
    const bindProgress = useCallback((setter: (t: number) => void) => {
      progressSetterRef.current = setter;
    }, []);
    const handleTimeUpdate = useCallback((t: number) => progressSetterRef.current(t), []);
    const handleScrub = useCallback((t: number) => {
      setIsPlaying(false);
      setScrubT(t);
    }, []);
    const handleTogglePlay = useCallback(() => {
      setIsPlaying((prev) => {
        const next = !prev;
        if (next) setScrubT(null); // resume from where we scrubbed to
        return next;
      });
    }, []);

    const getContentRef = useRef<(() => string) | null>(null);
    const previewHandlesRef = useRef<PreviewHandles | null>(null);
    const stepAssetsRef = useRef<StepAsset[]>([]);
    const fontAssetsRef = useRef<FontAsset[]>([]);
    const stepAssetsLoadedRef = useRef(false);
    const compileTokenRef = useRef(0);
    const refreshTimerRef = useRef<number | null>(null);
    const editorChangeCleanupRef = useRef<(() => void) | null>(null);
    const markerTargetRef = useRef<{
      model: unknown;
      setModelMarkers(model: unknown, owner: string, markers: CompileMarkerData[]): void;
      severity: MarkerSeverityValues;
    } | null>(null);
    const paramValuesRef = useRef<ParamValues>({});
    const exportInFlightRef = useRef(false);
    const selectionRef = useRef<ReplicadSelection | null>(null);
    paramValuesRef.current = paramValues;
    selectionRef.current = selection;

    const applyCompileMarkers = useCallback((result: CompileResult | null) => {
      const target = markerTargetRef.current;
      if (!target) return;
      const messages = result?.success === false ? result.diagnostics : [];
      target.setModelMarkers(
        target.model,
        'replicad',
        compileMessagesToMarkers(messages, target.severity)
      );
    }, []);

    useEffect(() => {
      applyCompileMarkers(compileResult);
    }, [applyCompileMarkers, compileResult]);

    const handleSelectionChange = useCallback((nextSelection: ReplicadSelection | null) => {
      selectionRef.current = nextSelection;
      setSelection(nextSelection);
    }, []);

    useEffect(() => {
      if (isCompiling || isExporting) setIsExportMenuOpen(false);
    }, [isCompiling, isExporting]);

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !isTabActive || event.defaultPrevented || isExportMenuOpen) return;
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest('input, textarea, [contenteditable="true"], .monaco-editor')
        ) {
          return;
        }
        handleSelectionChange(null);
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleSelectionChange, isExportMenuOpen, isTabActive]);

    useEffect(() => {
      const contextHost = host as typeof host & {
        setEditorContextItems?: (items: ReturnType<typeof selectionContextItem>[] | null) => void;
      };
      if (contextHost.setEditorContextItems) {
        contextHost.setEditorContextItems(selection ? [selectionContextItem(selection)] : null);
      } else {
        host.setEditorContext?.(
          selection
            ? {
                label: selectionContextLabel(selection),
                description: selectionContextDescription(selection),
              }
            : null
        );
      }
      return () => {
        contextHost.setEditorContextItems?.(null);
        if (!contextHost.setEditorContextItems) host.setEditorContext?.(null);
      };
    }, [host, selection]);

    const readSource = useCallback(
      async (filePath: string): Promise<string> => {
        if (getContentRef.current && filePath === host.filePath) return getContentRef.current();
        return filesystem.readFile(filePath);
      },
      [filesystem, host.filePath]
    );

    const refreshProjectGraph = useCallback(async (): Promise<ProjectGraphResult | null> => {
      if (!workspacePath) return null;
      try {
        const project = await buildProjectGraph(filesystem, workspacePath, {
          activeFileOverride: getContentRef.current
            ? { filePath: host.filePath, content: getContentRef.current() }
            : undefined,
        });
        setProjectGraph(project.graph);
        setConventions(project.conventions);
        setProjectError(null);

        // Cache STEP asset contents for the live compile loop.
        const assets: StepAsset[] = [];
        for (const assetPath of project.graph.stepAssets) {
          try {
            assets.push({ name: assetPath.split('/').pop() ?? assetPath, content: await filesystem.readFile(assetPath) });
          } catch {
            // ignore unreadable assets
          }
        }
        stepAssetsRef.current = assets;

        // Cache project font overrides (base64 sidecars) for the live compile loop.
        const fonts: FontAsset[] = [];
        for (const fontPath of project.graph.fontAssets) {
          try {
            fonts.push({ name: fontPath.split('/').pop() ?? fontPath, base64: (await filesystem.readFile(fontPath)).trim() });
          } catch {
            // ignore unreadable font sidecars
          }
        }
        fontAssetsRef.current = fonts;

        stepAssetsLoadedRef.current = true;
        return project;
      } catch (error) {
        setProjectGraph(null);
        setProjectError(`Failed to index Cutu CAD workspace: ${getErrorMessage(error)}`);
        return null;
      }
    }, [filesystem, host.filePath, workspacePath]);

    const runCompile = useCallback(
      async (overrides?: { params?: ParamValues; force?: boolean }): Promise<CompileResult | null> => {
        if (!workspacePath) return null;
        const filePath = host.filePath;
        const token = ++compileTokenRef.current;
        setIsCompiling(true);
        try {
          // STEP assets are gathered by refreshProjectGraph in a separate effect,
          // which may not have finished when the first compile fires. Without this,
          // a model that uses imported("...") compiles against an empty asset map
          // and fails with "No imported STEP asset". Ensure they are loaded once.
          if (!stepAssetsLoadedRef.current) {
            await refreshProjectGraph();
          }
          const source = await readSource(filePath);
          const result = await compileReplicad(environment, {
            source,
            filePath,
            params: overrides?.params ?? paramValuesRef.current,
            stepAssets: stepAssetsRef.current,
            fontAssets: fontAssetsRef.current,
          });
          if (token !== compileTokenRef.current) return result;
          handleSelectionChange(null);
          setCompileResult(result);
          if (result.success && result.shapes.length > 0) {
            setLastGoodResult(result);
          }
          if (result.params.length > 0 || result.success) {
            setParamDefs(result.params);
            setParamValues((previous) => initialValuesFromDefs(result.params, previous));
          }
          return result;
        } finally {
          if (token === compileTokenRef.current) setIsCompiling(false);
        }
      },
      [environment, handleSelectionChange, host.filePath, readSource, refreshProjectGraph, workspacePath]
    );

    // Compile the current model and write a manufacturable export next to the
    // source file. Drives the toolbar export menu below. Mirrors the export_model
    // AI tool, but scoped to the single open file and its current Customizer
    // params. STL (ASCII) / STEP / OBJ are utf8 and round-trip through the
    // text-only filesystem API; binary formats (3MF) are intentionally not
    // offered here because writeFile cannot persist them.
    const exportModel = useCallback(
      async (format: ExportFormat): Promise<void> => {
        if (!workspacePath) {
          ui.showError('Cutu CAD: workspace is not ready for export yet.');
          return;
        }
        if (exportInFlightRef.current) return;

        exportInFlightRef.current = true;
        setIsExporting(true);
        const filePath = host.filePath;
        try {
          if (!stepAssetsLoadedRef.current) {
            await refreshProjectGraph();
          }
          const source = await readSource(filePath);
          const result = await compileReplicad(environment, {
            source,
            filePath,
            params: paramValuesRef.current,
            stepAssets: stepAssetsRef.current,
            fontAssets: fontAssetsRef.current,
            exports: [format],
          });
          if (!result.success) {
            ui.showError(`Cutu CAD export failed: ${result.errors[0] ?? 'compile error'}`);
            return;
          }
          const artifact = result.exports?.find((entry) => entry.format === format);
          if (!artifact) {
            ui.showError(`Cutu CAD export produced no ${format.toUpperCase()} output.`);
            return;
          }
          if (artifact.encoding !== 'utf8') {
            ui.showError(`${format.toUpperCase()} is a binary format that cannot be written through the filesystem yet.`);
            return;
          }
          const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
          const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '.';
          const baseName = host.fileName.replace(/\.replicad\.ts$/i, '').replace(/\.ts$/i, '') || 'model';
          const outPath = `${dir}/${baseName}.${artifact.extension}`;
          await filesystem.writeFile(outPath, artifact.content);
          ui.showInfo(`Exported to ${outPath}`);
        } catch (error) {
          ui.showError(`Cutu CAD export failed: ${getErrorMessage(error)}`);
        } finally {
          exportInFlightRef.current = false;
          setIsExporting(false);
        }
      },
      [environment, filesystem, host.fileName, host.filePath, readSource, refreshProjectGraph, ui, workspacePath]
    );

    useEffect(() => {
      let cancelled = false;
      void resolveWorkspacePath(host.filePath)
        .then((resolved) => {
          if (cancelled) return;
          setWorkspacePath(resolved);
          setProjectError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          setWorkspacePath(null);
          setProjectError(`Failed to resolve workspace: ${getErrorMessage(error)}`);
        });
      return () => {
        cancelled = true;
      };
    }, [host.filePath]);

    useEffect(() => {
      if (!workspacePath) return;
      void refreshProjectGraph();
    }, [refreshProjectGraph, workspacePath]);

    useEffect(() => {
      if (!workspacePath || !isTabActive) return;
      void runCompile();
    }, [isTabActive, runCompile, workspacePath]);

    useEffect(() => host.onThemeChanged(setTheme), [host]);

    const scheduleRefresh = useCallback(() => {
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        void (async () => {
          await refreshProjectGraph();
          if (!isTabActive) return;
          await runCompile();
        })();
      }, compileDebounceMs);
    }, [compileDebounceMs, isTabActive, refreshProjectGraph, runCompile]);

    useEffect(() => host.onFileChanged(() => scheduleRefresh()), [host, scheduleRefresh]);

    useEffect(() => {
      return () => {
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        editorChangeCleanupRef.current?.();
        const target = markerTargetRef.current;
        if (target) target.setModelMarkers(target.model, 'replicad', []);
        markerTargetRef.current = null;
      };
    }, []);

    // Register the imperative API for AI tools.
    useEffect(() => {
      const api: ReplicadEditorAPI = {
        // This editor is bound to one open file; that file is the model.
        getActiveRoot: () => host.filePath,
        setActiveRoot: async () => {
          /* no-op: a single-file editor's model is its open tab */
        },
        getPreviewState: () => ({
          rootFilePath: host.filePath,
          wireframe,
          params: paramValuesRef.current,
          lastCompiledAt: compileResult ? new Date().toISOString() : undefined,
          renderTimeMs: compileResult?.renderTimeMs,
        }),
        getLatestDiagnostics: () => compileResult?.diagnostics ?? [],
        getLatestStats: () => compileResult?.stats ?? null,
        getSelection: () => selectionRef.current,
        getParams: () => paramDefs,
        setParamValues: async (values) => {
          setParamValues((previous) => ({ ...previous, ...values }));
          await runCompile({ params: { ...paramValuesRef.current, ...values }, force: true });
        },
        capturePreview: async () => previewHandlesRef.current?.capture() ?? null,
        captureViews: async (views) =>
          previewHandlesRef.current?.captureViews(views ?? ['iso', 'top', 'front', 'right']) ?? {},
        requestCompile: async (options) => {
          const result = await runCompile({ params: options?.params, force: options?.force });
          if (!result) throw new Error('Workspace not ready to compile');
          return result;
        },
        getProjectGraph: async () => {
          if (projectGraph) return projectGraph;
          const project = await refreshProjectGraph();
          if (!project) throw new Error(projectError ?? 'Failed to build Replicad project model');
          return project.graph;
        },
      };
      host.registerEditorAPI(api);
      return () => host.registerEditorAPI(null);
    }, [compileResult, host, paramDefs, projectError, projectGraph, refreshProjectGraph, runCompile, wireframe]);

    const handleParamChange = useCallback(
      (name: string, value: ParamValues[string]) => {
        setParamValues((previous) => {
          const next = { ...previous, [name]: value };
          paramValuesRef.current = next;
          return next;
        });
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          void runCompile({ params: paramValuesRef.current });
        }, compileDebounceMs);
      },
      [compileDebounceMs, runCompile]
    );

    // Prefer the current compile's geometry; fall back to the last good build so a
    // failed compile doesn't blank the preview. Diagnostics/status still reflect the
    // *current* compile below.
    const displayResult = compileResult?.shapes.length ? compileResult : lastGoodResult;
    const showingStale = Boolean(displayResult && displayResult !== compileResult && compileResult?.success === false);

    // Visibility belongs to this editor session, not the model. Keep existing
    // names across compiles, drop removed names, and show newly introduced shapes.
    useEffect(() => {
      setShapeVisibility((current) =>
        reconcileShapeVisibility(current, (displayResult?.shapes ?? []).map((shape) => shape.name))
      );
    }, [displayResult?.shapes]);

    // A compile can change the currently selected face without another pointer
    // event. Rebuild its measurements from the latest displayed geometry, or
    // clear it if that exact shape/face no longer exists.
    useEffect(() => {
      setSelection((current) => {
        const refreshed = refreshReplicadSelection(current, displayResult?.shapes ?? []);
        selectionRef.current = refreshed;
        return refreshed;
      });
    }, [displayResult?.shapes]);

    const handleShapeSelect = useCallback(
      (shape: ShapeResult) => {
        const bounds = meshBoundingBox(shape.mesh);
        handleSelectionChange(
          buildReplicadSelection(host.filePath, shape, null, [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2,
          ])
        );
      },
      [handleSelectionChange, host.filePath]
    );

    const handleShapeVisibilityToggle = useCallback(
      (shapeName: string) => {
        const willHide = isShapeVisible(shapeVisibility, shapeName);
        setShapeVisibility((current) => toggleShapeVisibility(current, shapeName));
        if (willHide && selectionRef.current?.shapeName === shapeName) {
          handleSelectionChange(null);
        }
      },
      [handleSelectionChange, shapeVisibility]
    );

    const handleShapeSolo = useCallback(
      (shapeName: string) => {
        const shapes = displayResult?.shapes ?? [];
        const next = soloShapeVisibility(shapeVisibility, shapes.map((shape) => shape.name), shapeName);
        const selectedShapeName = selectionRef.current?.shapeName;
        if (selectedShapeName && next[selectedShapeName] === false) {
          handleSelectionChange(null);
        }
        setShapeVisibility(next);
      },
      [displayResult?.shapes, handleSelectionChange, shapeVisibility]
    );

    const stats: ModelStats | null = displayResult?.stats ?? null;
    const printability = useMemo(() => {
      if (!displayResult?.success || !displayResult.stats || displayResult.shapes.length === 0) return null;
      const merged = mergeMeshes(displayResult.shapes.map((shape) => shape.mesh));
      return analyzePrintability(merged, displayResult.stats, {
        bedMm: conventions?.printerBed ?? null,
        nozzleMm: conventions?.printerNozzle ?? null,
      });
    }, [displayResult, conventions]);

    const diagnostics: CompileMessage[] = [
      ...(projectError ? [{ level: 'error', text: projectError } satisfies CompileMessage] : []),
      ...(compileResult?.diagnostics ?? []),
    ];
    const actionableDiagnostics = diagnostics.filter((entry) => entry.level !== 'info');
    const isBusy = isCompiling || isExporting;
    const statusState: 'working' | 'ok' | 'error' | 'idle' = isBusy
      ? 'working'
      : projectError || compileResult?.success === false
        ? 'error'
        : compileResult?.success
          ? 'ok'
          : 'idle';

    const statusLabel = isCompiling
      ? 'Compiling…'
      : isExporting
        ? 'Exporting…'
      : projectError
        ? 'Setup failed'
        : compileResult?.success
          ? `Compiled in ${Math.round(compileResult.renderTimeMs)} ms`
          : compileResult
            ? `${compileResult.errors.length || 1} error${(compileResult.errors.length || 1) === 1 ? '' : 's'}`
            : 'Idle';

    return (
      <div className="replicad-editor">
        <div className="replicad-toolbar" role="toolbar" aria-label="CAD tools">
          <div className="replicad-toolbar-group">
            <Button variant="ghost" size="sm" aria-pressed={!layout.paramsCollapsed && inspector === 'params'} onClick={() => toggleInspector('params')}>Parameters</Button>
            <Button variant="ghost" size="sm" aria-pressed={!layout.paramsCollapsed && inspector === 'parts'} onClick={() => toggleInspector('parts')}>Parts</Button>
            <Tooltip content="Edit the native parametric model">
              <Button variant="ghost" size="sm" aria-pressed={!layout.codeCollapsed} onClick={() => toggleCollapse('code')}>Source</Button>
            </Tooltip>
          </div>
          <div className="replicad-toolbar-group">
            <span className="replicad-status" data-state={statusState} role="status" aria-live="polite">
              <span className="replicad-status-dot" />{statusLabel}
            </span>
            <Menu triggerLabel="Export model" open={isExportMenuOpen} onOpenChange={setIsExportMenuOpen}
              trigger={(props) => <Button {...props} variant="ghost" size="sm" disabled={isBusy}>{isExporting ? 'Exporting…' : 'Export'}</Button>}>
              {TOOLBAR_EXPORT_FORMATS.map((format) => (
                <MenuItem key={format} onClick={() => void exportModel(format)}>{format.toUpperCase()}</MenuItem>
              ))}
            </Menu>
            <Menu triggerLabel="More CAD tools" trigger={(props) => <Button {...props} variant="ghost" size="sm">•••</Button>}>
              <MenuItem disabled={isBusy} onClick={() => void runCompile({ force: true })}>Rebuild model</MenuItem>
              <MenuItem onClick={() => setWireframe((value) => !value)}>{wireframe ? 'Show shaded model' : 'Show wireframe'}</MenuItem>
            </Menu>
          </div>
        </div>

        <div className="replicad-layout" ref={layoutRef} style={layoutVars}>
          <div className="replicad-main">
            <div className={`replicad-pane replicad-code-pane${layout.codeCollapsed ? ' replicad-collapsed' : ''}`}>
              <div className="replicad-pane-header">
                <span className="replicad-pane-title">Source</span>
                <button
                  type="button"
                  className="replicad-pane-collapse"
                  title={layout.codeCollapsed ? 'Show code' : 'Hide code'}
                  aria-label={layout.codeCollapsed ? 'Show code' : 'Hide code'}
                  aria-expanded={!layout.codeCollapsed}
                  onClick={() => toggleCollapse('code')}
                >
                  {layout.codeCollapsed ? '+' : '−'}
                </button>
              </div>
              <div className="replicad-pane-body">
                <MonacoEditor
                  host={host}
                  fileName={host.fileName}
                  onGetContent={(getContent) => {
                    getContentRef.current = getContent;
                  }}
                  onEditorReady={(wrapper) => {
                    registerReplicadIntellisense(wrapper?.monaco);
                    const editor = wrapper?.editor ?? wrapper;
                    const previousTarget = markerTargetRef.current;
                    if (previousTarget) previousTarget.setModelMarkers(previousTarget.model, 'replicad', []);
                    const model = editor?.getModel?.();
                    const setModelMarkers = wrapper?.monaco?.editor?.setModelMarkers;
                    const severity = wrapper?.monaco?.MarkerSeverity;
                    markerTargetRef.current = model && typeof setModelMarkers === 'function' && severity
                      ? { model, setModelMarkers: setModelMarkers.bind(wrapper.monaco.editor), severity }
                      : null;
                    applyCompileMarkers(compileResult);
                    if (!editor?.onDidChangeModelContent) return;
                    editorChangeCleanupRef.current?.();
                    const disposable = editor.onDidChangeModelContent((event: { isFlush?: boolean }) => {
                      if (event?.isFlush) return;
                      scheduleRefresh();
                    });
                    editorChangeCleanupRef.current =
                      typeof disposable?.dispose === 'function' ? () => disposable.dispose() : null;
                  }}
                />
              </div>
            </div>

            <Resizer
              target="code"
              disabled={layout.codeCollapsed}
              onPointerDown={beginResize('code')}
              onPointerMove={onResizeMove}
              onPointerUp={endResize}
            />

            <div className="replicad-preview-pane">
            <div className="replicad-preview-stage">
              {isTabActive && displayResult?.shapes.length ? (
                <PreviewPane
                  modelFilePath={host.filePath}
                  storage={host.storage}
                  shapes={displayResult.shapes}
                  animation={displayResult.animation}
                  wireframe={wireframe}
                  theme={theme}
                  playing={isPlaying}
                  scrubT={isPlaying ? null : scrubT}
                  onTimeUpdate={handleTimeUpdate}
                  selection={selection}
                  shapeVisibility={shapeVisibility}
                  onSelectionChange={handleSelectionChange}
                  onReady={(handles) => {
                    previewHandlesRef.current = handles;
                  }}
                />
              ) : (
                <div className="replicad-preview-empty">
                  {!isTabActive
                    ? 'Preview paused while this tab is inactive.'
                    : isCompiling
                      ? 'Compiling…'
                      : compileResult
                        ? 'Compile failed — see diagnostics below.'
                        : 'Waiting for compile…'}
                </div>
              )}

              {selection ? (
                <div className="replicad-selection-chip" role="status">
                  <span>
                    <strong>{selection.shapeName}</strong>
                    {selection.face ? ` > face ${selection.face.id}` : ''}
                    {' — '}
                    {selectionDimensions(selection)}
                  </span>
                  <button
                    type="button"
                    aria-label="Clear geometry selection"
                    title="Clear selection"
                    onClick={() => handleSelectionChange(null)}
                  >
                    x
                  </button>
                </div>
              ) : null}

              {showingStale ? (
                <div className="replicad-preview-stale" role="status">
                  Showing last successful build — current edit has errors.
                </div>
              ) : null}

              {stats ? (
                <div className="replicad-stats-overlay">
                  <strong>
                    {formatNumber(stats.boundingBox.size[0])} × {formatNumber(stats.boundingBox.size[1])} ×{' '}
                    {formatNumber(stats.boundingBox.size[2])} mm
                  </strong>
                  <span>{stats.triangleCount.toLocaleString()} tris</span>
                  {stats.volume > 0 ? <span>{formatNumber(stats.volume / 1000)} cm³</span> : null}
                  <span className={stats.watertight ? 'replicad-ok' : 'replicad-warn'}>
                    {stats.watertight ? 'watertight' : 'not watertight'}
                  </span>
                  {printability && !printability.ok ? <span className="replicad-warn">print warnings</span> : null}
                </div>
              ) : null}
            </div>

            {isTabActive && displayResult?.animation ? (
              <Timeline
                playing={isPlaying}
                durationMs={displayResult.animation.durationMs}
                onTogglePlay={handleTogglePlay}
                onScrub={handleScrub}
                bindProgress={bindProgress}
              />
            ) : null}

            {actionableDiagnostics.length > 0 ? (
              <div className="replicad-diagnostics">
                <ul className="replicad-diagnostics-list">
                  {actionableDiagnostics.slice(0, 12).map((entry, index) => (
                    <li
                      key={`${entry.level}-${index}-${entry.text}`}
                      className={`replicad-diagnostic replicad-diagnostic-${entry.level}`}
                    >
                      <span className="replicad-diagnostic-level">{entry.level}</span>
                      <span>{entry.text}</span>
                    </li>
                  ))}
                </ul>
                {actionableDiagnostics.length > 12 ? (
                  <div className="replicad-diagnostics-more">+{actionableDiagnostics.length - 12} more</div>
                ) : null}
              </div>
            ) : null}
            </div>
          </div>

          <Resizer
            target="params"
            disabled={layout.paramsCollapsed}
            onPointerDown={beginResize('params')}
            onPointerMove={onResizeMove}
            onPointerUp={endResize}
          />

          <div className={`replicad-pane replicad-params-pane${layout.paramsCollapsed ? ' replicad-collapsed' : ''}`}>
            <div className="replicad-pane-header">
              <span className="replicad-pane-title">{inspector === 'parts' ? 'Parts' : 'Parameters'}</span>
              <button
                type="button"
                className="replicad-pane-collapse"
                title={layout.paramsCollapsed ? 'Show parameters' : 'Hide parameters'}
                aria-label={layout.paramsCollapsed ? 'Show parameters' : 'Hide parameters'}
                aria-expanded={!layout.paramsCollapsed}
                onClick={() => toggleCollapse('params')}
              >
                {layout.paramsCollapsed ? '+' : '−'}
              </button>
            </div>
            <div className="replicad-pane-body">
              {inspector === 'parts' && displayResult && displayResult.shapes.length > 0 ? (
                <ShapeTreePanel
                  shapes={displayResult.shapes}
                  visibility={shapeVisibility}
                  selection={selection}
                  onSelect={handleShapeSelect}
                  onToggleVisibility={handleShapeVisibilityToggle}
                  onSolo={handleShapeSolo}
                />
              ) : null}
              {inspector === 'params' && <ParamsPanel defs={paramDefs} values={paramValues} onChange={handleParamChange} />}
            </div>
          </div>
        </div>
      </div>
    );
  };
}
