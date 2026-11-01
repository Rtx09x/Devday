import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Project, CadResult, Entity } from "@cutucircuits/core";
import type { ProgramMotion } from "./programMotion";
import { gaitTravel } from "./gaitTravel";
import { sceneIdentity } from "./assemblyCache";
import {
  assemblyStageFor,
  controllerStage,
  wiringStage,
  revealStep,
} from "./assemblyReveal";
import { useColorMode } from "./theme";
interface Props {
  project: Project;
  selected: string | null;
  onSelect: (id: string | null) => void;
  playing: boolean;
  phase: number;
  cad?: CadResult;
  reset: number;
  motionReset: number;
  program?: ProgramMotion;
  replayStage?: number | null;
  replayRun?: number;
}
export function Scene({
  project,
  selected,
  onSelect,
  playing,
  phase,
  cad,
  reset,
  motionReset,
  program,
  replayStage = null,
  replayRun = 0,
}: Props) {
  const sceneKey = sceneIdentity(project);
  const colorMode = useColorMode();
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const active = useRef({
    selected,
    playing,
    phase,
    program,
    onSelect,
    motionReset,
    replayStage,
    replayRun,
  });
  const playback = useRef({
    projectId: project.id,
    reset: motionReset,
    elapsed: 0,
  });
  if (playback.current.projectId !== project.id)
    playback.current = {
      projectId: project.id,
      reset: motionReset,
      elapsed: 0,
    };
  const fit = useRef<() => void>(() => {});
  const invalidateScene = useRef<() => void>(() => {});
  active.current = {
    selected,
    playing,
    phase,
    program,
    onSelect,
    motionReset,
    replayStage,
    replayRun,
  };
  useEffect(() => {
    fit.current();
  }, [reset]);
  useEffect(() => {
    invalidateScene.current();
  }, [selected, playing, phase, program, motionReset, replayStage, replayRun]);
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Camera and highlight changes reuse the same shadow map. Only actual
    // articulated geometry changes require another depth pass.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x212121, 0);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const reducedMotion = matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const camera = new THREE.PerspectiveCamera(33, 1, 0.2, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 20;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.05);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.75;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x56564e, 1.8));
    const key = new THREE.DirectionalLight(0xfff4e6, 3.2);
    key.position.set(-90, -130, 280);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.normalBias = 0.25;
    key.shadow.bias = -0.00012;
    key.shadow.radius = 4;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc6ddff, 2.3);
    rim.position.set(110, 120, 130);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 1.3);
    fill.position.set(100, -220, 40);
    scene.add(fill);
    const group = new THREE.Group();
    scene.add(group);
    const objects = new Map<string, THREE.Object3D>();
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    const shapeByName = new Map(cad?.shapes.map((s) => [s.name, s]));
    const entityById = new Map(project.entities.map((e) => [e.id, e]));
    function makeMaterial(entity: Entity, opacity: number) {
      const type = entity.metadata.material;
      const metal = type === "steel" || entity.geometry?.type === "wire";
      const material = new THREE.MeshPhysicalMaterial({
        color:
          colorMode === "light" && metal
            ? "#475569"
            : (entity.color ?? "#aebcbd"),
        emissiveIntensity: 0,
        metalness: metal ? (colorMode === "light" ? 0.2 : 0.83) : 0.02,
        roughness: metal
          ? colorMode === "light"
            ? 0.65
            : 0.24
          : type === "nylon"
            ? 0.58
            : type === "glue"
              ? 0.25
              : 0.39,
        clearcoat: type === "blue-servo" ? 0.5 : type === "glue" ? 0.6 : 0,
        clearcoatRoughness: 0.32,
        opacity,
        transparent: opacity < 1,
        depthWrite: opacity >= 0.9,
        envMapIntensity: metal ? 1.5 : 0.8,
      });
      materials.set(entity.id, material);
      material.userData.baseOpacity = opacity;
      return material;
    }
    function add(entity: Entity) {
      const g = entity.geometry;
      if (!g || entity.metadata.sceneHidden === true) return;
      const shape = shapeByName.get(g.shapeName ?? "");
      // Mesh-only parts wait for their authoritative kernel result. Never replace
      // the photo reconstruction with a fabricated arrangement of proxy boxes.
      if (g.type === "mesh" && !shape) return;
      let geometry: THREE.BufferGeometry;
      if (shape) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(shape.mesh.vertices, 3),
        );
        geometry.setIndex(shape.mesh.triangles);
        if (shape.mesh.normals.length === shape.mesh.vertices.length)
          geometry.setAttribute(
            "normal",
            new THREE.Float32BufferAttribute(shape.mesh.normals, 3),
          );
        else geometry.computeVertexNormals();
        geometry.translate(
          -entity.position[0],
          -entity.position[1],
          -entity.position[2],
        );
      } else if (g.type === "wire" && g.points?.length) {
        const path = new THREE.CurvePath<THREE.Vector3>();
        g.points
          .slice(1)
          .forEach((point, index) =>
            path.add(
              new THREE.LineCurve3(
                new THREE.Vector3(...g.points![index]),
                new THREE.Vector3(...point),
              ),
            ),
          );
        geometry = new THREE.TubeGeometry(
          path,
          Math.max(24, g.points.length * 12),
          g.radius ?? 0.55,
          10,
          false,
        );
      } else if (g.type === "cylinder") {
        geometry = new THREE.CylinderGeometry(
          g.radius ?? 4,
          g.radius ?? 4,
          g.length ?? 8,
          32,
        );
        geometry.rotateX(Math.PI / 2);
      } else geometry = new THREE.BoxGeometry(...(g.size ?? [10, 10, 8]));
      const material = makeMaterial(entity, shape?.opacity ?? 1);
      if (
        shape?.color &&
        !(
          colorMode === "light" &&
          (entity.metadata.material === "steel" ||
            entity.geometry?.type === "wire")
        )
      )
        material.color.set(shape.color);
      const object = new THREE.Mesh(geometry, material);
      object.position.set(...entity.position);
      if (entity.rotation) object.rotation.set(...entity.rotation);
      object.castShadow = entity.metadata.material !== "glue";
      object.receiveShadow = true;
      object.userData.entityId = entity.id;
      object.userData.baseRotation = object.rotation.clone();
      object.userData.basePosition = object.position.clone();
      objects.set(entity.id, object);
      group.add(object);
    }
    project.entities.forEach(add);
    // Generic projects may contain an unbound native model. Keep these meshes
    // visible without requiring them to be converted to built-in primitives.
    if (
      cad &&
      !project.entities.some((e) =>
        shapeByName.has(e.geometry?.shapeName ?? ""),
      )
    ) {
      for (const shape of cad.shapes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(shape.mesh.vertices, 3),
        );
        geometry.setIndex(shape.mesh.triangles);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: shape.color ?? "#80cbc4",
            roughness: 0.4,
            metalness: 0.15,
            opacity: shape.opacity ?? 1,
            transparent: (shape.opacity ?? 1) < 1,
          }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    const bounds = new THREE.Box3().setFromObject(group);
    const center = bounds.isEmpty()
      ? new THREE.Vector3()
      : bounds.getCenter(new THREE.Vector3());
    const span = bounds.isEmpty()
      ? 100
      : Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 50);
    const floorZ = bounds.isEmpty() ? 0 : bounds.min.z - 0.4;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 8, span * 8),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.24 }),
    );
    ground.position.z = floorZ;
    ground.receiveShadow = true;
    scene.add(ground);
    const gridSize = Math.ceil((span * 2) / 10) * 10;
    const gridDivisions = Math.min(80, Math.ceil((span * 2) / 10));
    const gridSpacing = gridSize / gridDivisions;
    const grid = new THREE.GridHelper(
      gridSize,
      gridDivisions,
      colorMode === "light" ? 0x64748b : 0x586260,
      colorMode === "light" ? 0x94a3b8 : 0x424a48,
    );
    grid.rotation.x = Math.PI / 2;
    grid.position.z = floorZ - 0.03;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = colorMode === "light" ? 0.22 : 0.22;
    gridMaterial.depthWrite = false;
    scene.add(grid);
    const shadowSpan = span * 0.8;
    Object.assign(key.shadow.camera, {
      left: -shadowSpan,
      right: shadowSpan,
      top: shadowSpan,
      bottom: -shadowSpan,
      near: 1,
      far: span * 6,
    });
    key.target.position.copy(center);
    scene.add(key.target);
    key.shadow.camera.updateProjectionMatrix();
    camera.far = span * 40;
    controls.maxDistance = span * 12;
    controls.target.copy(center);
    let frame: number | null = null;
    let disposed = false;
    let contextLost = false;
    let lastTime = performance.now();
    const invalidate = () => {
      if (!disposed && !contextLost && !document.hidden && frame === null)
        frame = requestAnimationFrame(animate);
    };
    invalidateScene.current = invalidate;
    controls.addEventListener("change", invalidate);
    const viewDirection = new THREE.Vector3(0.9, -1.6, 0.92).normalize();
    const fitPosition = new THREE.Vector3();
    const fitTarget = center.clone();
    const followed = new THREE.Vector3();
    let fitting = false;
    const fitCamera = (instant = false) => {
      const replay = active.current.replayStage;
      const rearDetail = replay === controllerStage || replay === wiringStage;
      const closeDetail = (replay !== null && replay < 2) || rearDetail;
      const frameBounds = closeDetail ? new THREE.Box3() : bounds;
      if (closeDetail && replay !== null) {
        group.updateWorldMatrix(true, true);
        for (const [id, object] of objects) {
          const stage = assemblyStageFor(id);
          // The wide wire legs stay visible, but do not shrink the controller
          // and signal connections during their dedicated rear detail shots.
          if (stage <= replay && (stage < 2 || stage >= controllerStage))
            frameBounds.expandByObject(object);
        }
      }
      const frameCenter = frameBounds.isEmpty()
        ? center
        : frameBounds.getCenter(new THREE.Vector3());
      const direction = rearDetail
        ? new THREE.Vector3(-0.45, 1.6, 0.75).normalize()
        : viewDirection;
      const right = new THREE.Vector3()
        .crossVectors(direction, camera.up)
        .normalize();
      const up = new THREE.Vector3().crossVectors(right, direction).normalize();
      let width = 0,
        height = 0,
        depth = 0;
      for (const x of [frameBounds.min.x, frameBounds.max.x])
        for (const y of [frameBounds.min.y, frameBounds.max.y])
          for (const z of [frameBounds.min.z, frameBounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z).sub(frameCenter);
            width = Math.max(width, Math.abs(corner.dot(right)));
            height = Math.max(height, Math.abs(corner.dot(up)));
            depth = Math.max(depth, Math.abs(corner.dot(direction)));
          }
      const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const distance = frameBounds.isEmpty()
        ? 200
        : Math.max(width / (tan * camera.aspect), height / tan) * 1.12 +
          depth * 0.65;
      fitPosition
        .copy(frameCenter)
        .add(followed)
        .addScaledVector(direction, distance);
      fitTarget.copy(frameCenter).add(followed);
      if (instant || reducedMotion) {
        camera.position.copy(fitPosition);
        controls.target.copy(fitTarget);
        fitting = false;
      } else fitting = true;
      camera.updateProjectionMatrix();
    };
    fit.current = () => {
      fitCamera();
      invalidate();
    };
    controls.addEventListener("start", () => {
      fitting = false;
    });
    let firstSize = true;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      const previousAspect = camera.aspect;
      camera.aspect = w / h;
      if (firstSize) {
        fitCamera(true);
        firstSize = false;
      } else if (Math.abs(previousAspect - camera.aspect) > 0.08) fitCamera();
      camera.updateProjectionMatrix();
      invalidate();
    });
    observer.observe(el);
    const raycaster = new THREE.Raycaster();
    // Thin wire remains selectable at normal assembly framing.
    const pointer = new THREE.Vector2();
    let down = [0, 0];
    const start = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
    };
    const pick = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const rect = el.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(
        [...objects.values()].filter(
          (object) =>
            object.visible &&
            (active.current.replayStage === null ||
              assemblyStageFor(object.userData.entityId) <=
                active.current.replayStage),
        ),
        false,
      )[0];
      active.current.onSelect(hit?.object.userData.entityId ?? null);
    };
    renderer.domElement.addEventListener("pointerdown", start);
    renderer.domElement.addEventListener("pointerup", pick);
    let elapsed = playback.current.elapsed;
    const lightOffset = key.position.clone();
    const jointRotations = new Map<string, number>();
    let framedReplay: number | null = null;
    let framedRun = -1;
    const animate = (now: number) => {
      frame = null;
      const delta = Math.min(Math.max((now - lastTime) / 1000, 1 / 240), 0.1);
      lastTime = now;
      let highlightsSettling = false;
      let revealSettling = false;
      const current = active.current;
      if (playback.current.reset !== current.motionReset) {
        playback.current.reset = current.motionReset;
        elapsed = 0;
      }
      if (current.playing && !current.program) elapsed += delta;
      playback.current.elapsed = elapsed;
      const travel = new THREE.Vector3(...gaitTravel(project.motion, elapsed));
      if (!group.position.equals(travel)) renderer.shadowMap.needsUpdate = true;
      group.position.copy(travel);
      el.dataset.previewDistanceMm = String(travel.length());
      el.dataset.previewOffset = JSON.stringify(group.position.toArray());
      // Let the robot visibly cross the grid, then follow it to keep it in view.
      const follow = travel
        .clone()
        .setLength(Math.max(0, travel.length() - span * 0.25));
      const cameraShift = follow.clone().sub(followed);
      camera.position.add(cameraShift);
      controls.target.add(cameraShift);
      fitPosition.add(cameraShift);
      fitTarget.add(cameraShift);
      followed.copy(follow);
      ground.position.x = travel.x;
      ground.position.y = travel.y;
      grid.position.x = Math.round(travel.x / gridSpacing) * gridSpacing;
      grid.position.y = Math.round(travel.y / gridSpacing) * gridSpacing;
      key.position.copy(lightOffset).add(travel);
      key.target.position.copy(center).add(travel);
      if (
        framedReplay !== current.replayStage ||
        framedRun !== current.replayRun
      ) {
        if (current.replayStage === null && framedReplay !== null) {
          for (const object of objects.values()) {
            object.position.copy(object.userData.basePosition);
            object.rotation.copy(object.userData.baseRotation);
          }
          jointRotations.clear();
        }
        if (current.replayStage === 0 && framedRun !== current.replayRun) {
          for (const [id, material] of materials) {
            material.opacity = 0;
            material.transparent = true;
            material.depthWrite = false;
            material.needsUpdate = true;
            const object = objects.get(id);
            if (object) object.visible = false;
          }
          renderer.shadowMap.needsUpdate = true;
        }
        if (
          current.replayStage !== null ||
          (framedReplay !== null &&
            (framedReplay < 2 ||
              framedReplay === controllerStage ||
              framedReplay === wiringStage))
        )
          fitCamera();
        framedReplay = current.replayStage;
        framedRun = current.replayRun;
      }
      for (const [id, material] of materials) {
        const targetOpacity =
          current.replayStage === null ||
          assemblyStageFor(id) <= current.replayStage
            ? (material.userData.baseOpacity as number)
            : 0;
        const nextOpacity = revealStep(
          material.opacity,
          targetOpacity,
          delta,
          reducedMotion,
        );
        revealSettling ||= nextOpacity !== targetOpacity;
        if (nextOpacity !== material.opacity)
          renderer.shadowMap.needsUpdate = true;
        material.opacity = nextOpacity;
        const transparent = nextOpacity < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.depthWrite = nextOpacity >= 0.9;
        const object = objects.get(id);
        if (object) {
          object.visible = nextOpacity > 0.005;
          // Each leg and its foot share the same reveal factor and translation.
          // Always start from authored coordinates so nothing drifts or detaches.
          if (current.replayStage !== null) {
            object.position.copy(object.userData.basePosition);
            object.rotation.copy(object.userData.baseRotation);
            if (!reducedMotion && targetOpacity > 0)
              object.position.z += (1 - nextOpacity / targetOpacity) * 1.5;
          }
        }
        const entity = entityById.get(id);
        const selectedPart =
          id === current.selected || entity?.parentId === current.selected;
        const linked = entity?.metadata.driver === current.selected;
        material.emissive.set(selectedPart ? "#80cbc4" : "#284b46");
        const intensity = selectedPart ? 0.25 : linked ? 0.1 : 0;
        if (
          reducedMotion ||
          Math.abs(material.emissiveIntensity - intensity) < 0.0005
        ) {
          material.emissiveIntensity = intensity;
        } else {
          material.emissiveIntensity = THREE.MathUtils.damp(
            material.emissiveIntensity,
            intensity,
            16,
            delta,
          );
          highlightsSettling = true;
        }
      }
      el.dataset.assemblyReplayStage =
        current.replayStage === null ? "complete" : String(current.replayStage);
      el.dataset.visibleEntityCount = String(
        [...objects.values()].filter((object) => object.visible).length,
      );
      const motion = project.motion;
      if (motion && current.replayStage === null) {
        let phaseIndex = current.phase,
          progress = 1;
        if (current.playing) {
          const total = motion.phases.reduce(
            (s, p) => s + p.durationMs + p.settleMs,
            0,
          );
          let time = (elapsed * 1000) % total;
          phaseIndex = 0;
          for (let i = 0; i < motion.phases.length; i++) {
            const p = motion.phases[i];
            if (time < p.durationMs + p.settleMs) {
              phaseIndex = i;
              progress = Math.min(1, time / Math.max(p.durationMs, 1));
              break;
            }
            time -= p.durationMs + p.settleMs;
          }
        }
        const targetPhase = motion.phases[Math.max(0, phaseIndex)];
        for (const joint of motion.joints) {
          const target =
            targetPhase?.targets[joint.entityId] ??
            targetPhase?.targets[joint.channel ?? ""] ??
            joint.centerUs;
          const previousPhase =
            motion.phases[
              (phaseIndex - 1 + motion.phases.length) % motion.phases.length
            ];
          const previous =
            previousPhase?.targets[joint.entityId] ??
            previousPhase?.targets[joint.channel ?? ""] ??
            joint.centerUs;
          const pulse = current.program
            ? (current.program.targets[joint.entityId] ?? joint.centerUs)
            : current.playing
              ? previous + (target - previous) * progress
              : target;
          const angle =
            (((pulse - joint.centerUs) / (joint.pulsePerDegree ?? 10)) *
              Math.PI) /
            180;
          const desiredRotation =
            current.program || current.playing || current.phase >= 0
              ? angle
              : 0;
          const previousRotation = jointRotations.get(joint.entityId) ?? 0;
          const smoothing =
            current.program?.source === "device" &&
            !reducedMotion &&
            Math.abs(desiredRotation - previousRotation) > 0.0001;
          const rotation = smoothing
            ? THREE.MathUtils.damp(previousRotation, desiredRotation, 14, delta)
            : desiredRotation;
          highlightsSettling ||= smoothing;
          if (jointRotations.get(joint.entityId) === rotation) continue;
          jointRotations.set(joint.entityId, rotation);
          renderer.shadowMap.needsUpdate = true;
          const axis = new THREE.Vector3(...joint.axis).normalize();
          const driver = entityById.get(joint.entityId);
          const authoredPivot = driver?.metadata.jointPivot;
          const pivot = new THREE.Vector3(
            ...(Array.isArray(authoredPivot) && authoredPivot.length === 3
              ? (authoredPivot as [number, number, number])
              : (driver?.position ?? [0, 0, 0])),
          );
          for (const id of joint.drivenEntityIds ?? [joint.entityId]) {
            const object = objects.get(id);
            if (!object) continue;
            object.rotation.copy(object.userData.baseRotation);
            object.position
              .copy(object.userData.basePosition)
              .sub(pivot)
              .applyAxisAngle(axis, rotation)
              .add(pivot);
            object.rotateOnAxis(axis, rotation);
          }
        }
      }
      if (fitting) {
        const factor = 1 - Math.exp(-delta * 3.5);
        camera.position.lerp(fitPosition, factor);
        controls.target.lerp(fitTarget, factor);
        if (camera.position.distanceToSquared(fitPosition) < 0.01)
          fitting = false;
      }
      const orbitChanged = controls.update();
      renderer.render(scene, camera);
      // OrbitControls emits changes while damping. Once camera, selection and
      // motion settle, release RAF entirely until the next user/state event.
      if (
        current.playing ||
        fitting ||
        highlightsSettling ||
        revealSettling ||
        orbitChanged
      )
        invalidate();
    };
    const visibility = () => {
      if (document.hidden) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      } else {
        lastTime = performance.now();
        invalidate();
      }
    };
    const loseContext = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.dispatchEvent(
        new CustomEvent("cutu:build-rendering-paused", { detail: true }),
      );
    };
    const restoreContext = () => {
      contextLost = false;
      lastTime = performance.now();
      renderer.shadowMap.needsUpdate = true;
      window.dispatchEvent(
        new CustomEvent("cutu:build-rendering-paused", { detail: false }),
      );
      invalidate();
    };
    document.addEventListener("visibilitychange", visibility);
    renderer.domElement.addEventListener("webglcontextlost", loseContext);
    renderer.domElement.addEventListener(
      "webglcontextrestored",
      restoreContext,
    );
    invalidate();
    return () => {
      disposed = true;
      fit.current = () => {};
      invalidateScene.current = () => {};
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      renderer.domElement.removeEventListener("webglcontextlost", loseContext);
      renderer.domElement.removeEventListener(
        "webglcontextrestored",
        restoreContext,
      );
      observer.disconnect();
      controls.removeEventListener("change", invalidate);
      controls.dispose();
      environment.dispose();
      renderer.domElement.removeEventListener("pointerdown", start);
      renderer.domElement.removeEventListener("pointerup", pick);
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.LineSegments
        ) {
          object.geometry.dispose();
          (Array.isArray(object.material)
            ? object.material
            : [object.material]
          ).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [sceneKey, cad, colorMode]);
  return (
    <div
      className="scene"
      ref={host}
      aria-label="Interactive assembly. Drag to orbit, shift drag to pan, scroll to zoom."
    >
      {failed && (
        <div className="center-state">
          3D rendering is unavailable in this browser. Use the object tree or
          native source view.
        </div>
      )}
    </div>
  );
}
