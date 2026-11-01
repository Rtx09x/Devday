import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import URDFLoader from 'urdf-loader';
import type { RobotModel, RobotSnapshot } from '@cutucircuits/robotics';
import type { projectResources } from './projectResources';
import { useColorMode } from '../theme';

export interface RobotSource {
  xml: string;
  model: RobotModel;
  resources: ReturnType<typeof projectResources>;
}
export interface ViewportController {
  pose(snapshot: RobotSnapshot | null, targets: Record<string, number>): void;
  fit(): void;
  colliders(visible: boolean): void;
}
interface Props {
  source: RobotSource;
  onController: (controller: ViewportController | null) => void;
  onIssue: (issue: string) => void;
  onLink: (name: string | null) => void;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

export default function RobotViewport({ source, onController, onIssue, onLink }: Props) {
  const colorMode = useColorMode();
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onController, onIssue, onLink });
  callbacks.current = { onController, onIssue, onLink };
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const element = host.current!;
    let alive = true;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      setFailure('The robot viewport needs WebGL. You can still inspect the source.');
      return;
    }
    setFailure('');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x212121, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.001, 10000);
    camera.up.set(0, 0, 1);
    camera.position.set(2, -3, 2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.dampingFactor = 0.12;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x525758, 2.3));
    const light = new THREE.DirectionalLight(0xffffff, 2.7);
    light.position.set(3, -4, 7);
    scene.add(light);
    const ground = new THREE.GridHelper(10, 40, colorMode === 'light' ? 0x64748b : 0x6c8784, colorMode === 'light' ? 0xcbd5e1 : 0x444b4b);
    ground.rotation.x = Math.PI / 2;
    ground.position.z = -0.001;
    (ground.material as THREE.Material).transparent = true;
    (ground.material as THREE.Material).opacity = 0.25;
    scene.add(ground);
    const axes = new THREE.AxesHelper(0.2);
    scene.add(axes);
    let frame = 0;
    const render = () => {
      frame = 0;
      if (!alive) return;
      const moving = controls.update();
      renderer.render(scene, camera);
      if (moving) invalidate();
    };
    const invalidate = () => { if (alive && !frame) frame = requestAnimationFrame(render); };
    controls.addEventListener('change', invalidate);
    const resize = new ResizeObserver(() => {
      const width = element.clientWidth, height = element.clientHeight;
      renderer.setSize(Math.max(1, width), Math.max(1, height));
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      invalidate();
    });
    resize.observe(element);

    const report = (error: unknown) => { if (alive) callbacks.current.onIssue(error instanceof Error ? error.message : String(error)); };
    const pending: Promise<void>[] = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      try { return source.resources.rawUrl(url); }
      catch (error) { report(error); return 'data:,'; }
    });
    manager.onLoad = invalidate;
    manager.onError = url => report(`A companion texture could not be loaded: ${url}`);
    const loader = new URDFLoader(manager);
    loader.packages = name => 'package://' + name;
    loader.parseCollision = true;
    loader.loadMeshCb = (filename, _manager, material, done) => {
      pending.push((async () => {
        try {
          const { data, path } = await source.resources.resolve(filename);
          if (!alive) return;
          let object: THREE.Object3D;
          if (/\.stl$/i.test(path)) object = new THREE.Mesh(new STLLoader().parse(data), material);
          else if (/\.dae$/i.test(path)) {
            const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
            object = new ColladaLoader(manager).parse(new TextDecoder().decode(data), directory).scene;
          } else throw new Error(`Unsupported visual mesh: ${filename}. Use STL or DAE.`);
          done(object);
          invalidate();
        } catch (error) {
          if (!alive) return;
          report(error);
          done(new THREE.Group(), error instanceof Error ? error : new Error(String(error)));
        }
      })());
    };

    let robot: ReturnType<URDFLoader['parse']>;
    const visualRoot = new THREE.Group();
    scene.add(visualRoot);
    const linkGroups = new Map<string, THREE.Group>();
    const collisionObjects: THREE.Object3D[] = [];
    let showCollisions = false;
    const applyCollisionVisibility = () => {
      for (const object of collisionObjects) object.visible = showCollisions;
      invalidate();
    };
    const fit = () => {
      const bounds = new THREE.Box3().setFromObject(visualRoot);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      const size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.1);
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(1.1, -1.7, 1.0).normalize().multiplyScalar(size * 1.6));
      camera.near = Math.max(0.0001, size / 1000);
      camera.far = Math.max(100, size * 1000);
      camera.updateProjectionMatrix();
      controls.minDistance = size / 20;
      controls.maxDistance = size * 40;
      ground.scale.setScalar(Math.max(size, 0.2));
      axes.scale.setScalar(Math.max(size, 0.2));
      controls.update();
      invalidate();
    };
    try {
      robot = loader.parse(source.xml);
      // Keep URDFLoader's native hierarchy for FK. Visuals are rendered under
      // independent link frames so absolute physics poses cannot compound.
      for (const [name, link] of Object.entries(robot.links)) {
        const group = new THREE.Group();
        group.name = name;
        group.userData.linkName = name;
        for (const child of [...link.children]) {
          if ((child as THREE.Object3D & { isURDFJoint?: boolean }).isURDFJoint) continue;
          group.add(child);
          if ((child as THREE.Object3D & { isURDFCollider?: boolean }).isURDFCollider || child.type === 'URDFCollider') {
            collisionObjects.push(child);
            child.traverse(object => {
              const mesh = object as THREE.Mesh;
              if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ color: 0x80cbc4, wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
            });
          }
        }
        linkGroups.set(name, group);
        visualRoot.add(group);
      }
      const pose: ViewportController['pose'] = (snapshot, targets) => {
        if (!alive) return;
        if (!snapshot) {
          robot.setJointValues(Object.fromEntries(source.model.joints.map(joint => [joint.name, targets[joint.name] ?? 0])));
          robot.updateMatrixWorld(true);
        }
        for (const [name, group] of linkGroups) {
          const transform = snapshot?.links[name];
          if (transform) {
            group.position.fromArray(transform.position);
            group.quaternion.fromArray(transform.quaternion);
          } else if (!snapshot) robot.links[name].matrixWorld.decompose(group.position, group.quaternion, group.scale);
        }
        visualRoot.updateMatrixWorld(true);
        invalidate();
      };
      callbacks.current.onController({ pose, fit, colliders: visible => { showCollisions = visible; applyCollisionVisibility(); } });
      pose(null, {});
      applyCollisionVisibility();
      fit();
      void Promise.allSettled(pending).then(() => {
        if (!alive) return;
        // Async mesh children need the same collider diagnostic material.
        for (const collider of collisionObjects) collider.traverse(object => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ color: 0x80cbc4, wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
        });
        applyCollisionVisibility();
        fit();
      });
    } catch (error) { report(error); }

    const raycaster = new THREE.Raycaster();
    let pointerStart: [number, number] = [0, 0];
    const pointerDown = (event: PointerEvent) => { pointerStart = [event.clientX, event.clientY]; };
    const pointerUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const hit = raycaster.intersectObject(visualRoot, true).find(hit => hit.object.visible && !collisionObjects.some(collider => collider === hit.object || collider.getObjectById(hit.object.id)));
      let object: THREE.Object3D | null = hit?.object ?? null;
      while (object && !object.userData.linkName) object = object.parent;
      callbacks.current.onLink(object?.userData.linkName ?? null);
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    invalidate();
    return () => {
      alive = false;
      callbacks.current.onController(null);
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [source, colorMode]);
  return <div className="cutu-robot-viewport" ref={host} aria-label={`${source.model.name} URDF viewport`} role="region">
    {failure && <div className="cutu-robot-empty" role="alert">{failure}</div>}
  </div>;
}
