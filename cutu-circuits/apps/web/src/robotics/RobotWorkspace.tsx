import { useEffect, useRef, useState } from 'react';
import type { Asset, FileSnapshot, Project } from '@cutucircuits/core';
import { createRobotSimulation, parseUrdf, type RobotSimulation, type RobotSnapshot } from '@cutucircuits/robotics';
import { Button, IconButton, SettingsRow, Slider, Switch } from '@cutucircuits/ui';
import { Glyph } from '../Glyph';
import RobotViewport, { type RobotSource, type ViewportController } from './RobotViewport';
import { projectResources } from './projectResources';
import './robotics.css';

interface Props {
  project: Project;
  asset: Asset;
  onOpenSource?: () => void;
  onSelection?: (entityId: string | null) => void;
  onNotice?: (message: string) => void;
}

export default function RobotWorkspace({ project, asset, onOpenSource, onSelection, onNotice }: Props) {
  const [source, setSource] = useState<RobotSource>();
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [mode, setMode] = useState<'inspect' | 'physics'>('inspect');
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [physicsError, setPhysicsError] = useState('');
  const [panel, setPanel] = useState<'joints' | 'settings' | null>(null);
  const [fixedBase, setFixedBase] = useState(true);
  const [ground, setGround] = useState(true);
  const [gravity, setGravity] = useState(true);
  const [colliders, setColliders] = useState(false);
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [snapshot, setSnapshot] = useState<RobotSnapshot | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const viewport = useRef<ViewportController | null>(null);
  const simulation = useRef<RobotSimulation | null>(null);
  const active = useRef({ mode, targets, snapshot, colliders });
  active.current = { mode, targets, snapshot, colliders };
  const callbacks = useRef({ onNotice });
  callbacks.current = { onNotice };
  const addIssue = (message: string) => setIssues(previous => previous.includes(message) ? previous : [...previous, message]);

  useEffect(() => {
    const abort = new AbortController();
    setSource(undefined);
    setError('');
    setIssues([]);
    setPlaying(false);
    setTargets({});
    setSnapshot(null);
    setSelectedLink(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/files?path=${encodeURIComponent(asset.path)}`, { signal: abort.signal });
        const file = await response.json() as FileSnapshot & { error?: { message: string } };
        if (!response.ok) throw new Error(file.error?.message ?? 'Could not open the URDF source.');
        const model = parseUrdf(file.content);
        if (abort.signal.aborted) return;
        setSource({ xml: file.content, model, resources: projectResources(project, asset.path, abort.signal) });
        setIssues(model.diagnostics.map(diagnostic => diagnostic.message));
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void load();
    return () => abort.abort();
  }, [project.id, project.revision, asset.path]);

  useEffect(() => {
    setPlaying(false);
    setReady(false);
    setPhysicsError('');
    setSnapshot(null);
    let cancelled = false;
    if (mode === 'inspect') viewport.current?.pose(null, active.current.targets);
    if (mode === 'physics' && source) {
      void createRobotSimulation(source.model, {
        fixedBase, ground, gravity: gravity ? [0, 0, -9.81] : [0, 0, 0], timestep: 1 / 120,
        meshResolver: source.resources.meshResolver,
      }).then(engine => {
        if (cancelled) { engine.dispose(); return; }
        simulation.current = engine;
        for (const [name, target] of Object.entries(active.current.targets)) engine.setJointTarget(name, target);
        const initial = engine.snapshot();
        setSnapshot(initial);
        viewport.current?.pose(initial, {});
        setReady(true);
        for (const diagnostic of engine.diagnostics) addIssue(diagnostic.message);
      }).catch(failure => {
        if (!cancelled) {
          const message = `Physics could not start: ${failure instanceof Error ? failure.message : String(failure)}`;
          addIssue(message);
          setPhysicsError(message);
          callbacks.current.onNotice?.(message);
        }
      });
    }
    return () => {
      cancelled = true;
      simulation.current?.dispose();
      simulation.current = null;
    };
  }, [source, mode, fixedBase, ground, gravity]);

  useEffect(() => {
    if (!playing || mode !== 'physics' || !ready) return;
    let frame = 0, previousTime = 0, remainder = 0, lastStatus = 0;
    const tick = (time: number) => {
      const engine = simulation.current;
      if (!engine) return;
      if (previousTime) remainder += Math.min((time - previousTime) / 1000, 0.1);
      previousTime = time;
      const steps = Math.min(12, Math.floor(remainder / engine.timestep));
      if (steps) {
        remainder -= steps * engine.timestep;
        try {
          const next = engine.step(steps);
          active.current.snapshot = next;
          viewport.current?.pose(next, {});
          if (time - lastStatus > 100) { setSnapshot(next); lastStatus = time; }
        } catch (failure) { setPlaying(false); addIssue(String(failure)); return; }
      }
      frame = requestAnimationFrame(tick);
    };
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      if (simulation.current) setSnapshot(simulation.current.snapshot());
    };
  }, [playing, mode, ready]);

  const setTarget = (name: string, value: number) => {
    const next = { ...targets, [name]: value };
    setTargets(next);
    if (mode === 'inspect') viewport.current?.pose(null, next);
    else simulation.current?.setJointTarget(name, value);
  };
  const step = () => {
    if (!simulation.current) return;
    try {
      const next = simulation.current.step();
      setSnapshot(next);
      viewport.current?.pose(next, {});
    } catch (failure) { addIssue(String(failure)); }
  };
  const reset = () => {
    setPlaying(false);
    setTargets({});
    if (mode === 'physics' && simulation.current) {
      const next = simulation.current.reset();
      setSnapshot(next);
      viewport.current?.pose(next, {});
    } else viewport.current?.pose(null, {});
  };
  const movableJoints = source?.model.joints.filter(joint => joint.type !== 'fixed') ?? [];
  const rootPosition = source && snapshot?.links[source.model.root]?.position;
  const selected = source?.model.links.find(link => link.name === selectedLink);

  return <section className="cutu-robot-workspace" aria-label="Robot workspace">
    {source ? <RobotViewport source={source} onIssue={addIssue} onController={controller => {
      viewport.current = controller;
      controller?.pose(active.current.mode === 'physics' ? active.current.snapshot : null, active.current.targets);
      controller?.colliders(active.current.colliders);
    }} onLink={name => {
      setSelectedLink(name);
      const entity = project.entities.find(entity => entity.metadata.urdfLink === name || entity.metadata.robotLink === name || entity.name === name);
      onSelection?.(entity?.id ?? null);
    }} /> : <div className="cutu-robot-empty" role={error ? 'alert' : 'status'}>
      <Glyph name="cube" /><strong>{error ? 'Could not open robot' : 'Opening URDF…'}</strong>
      {error && <p>{error}</p>}{error && onOpenSource && <Button variant="filled" size="sm" onClick={onOpenSource}>Open source</Button>}
    </div>}
    <div className="cutu-robot-toolbar">
      <div className="cutu-robot-segment" role="group" aria-label="Robot mode">
        <Button aria-pressed={mode === 'inspect'} onClick={() => setMode('inspect')}>Inspect</Button>
        <Button aria-pressed={mode === 'physics'} onClick={() => setMode('physics')}>Physics</Button>
      </div>
      <div className="cutu-robot-toolbar-actions">
        <Button variant="ghost" size="sm" aria-expanded={panel === 'joints'} onClick={() => setPanel(panel === 'joints' ? null : 'joints')} disabled={!source}>Joints <span className="cutu-robot-count">{movableJoints.length}</span></Button>
        <IconButton label="Robot settings" aria-expanded={panel === 'settings'} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}><Glyph name="more" /></IconButton>
        <IconButton label="Fit robot" onClick={() => viewport.current?.fit()} disabled={!source}><Glyph name="fit" /></IconButton>
      </div>
    </div>
    {source && <div className="cutu-robot-caption"><strong>{source.model.name}</strong><span>{source.model.links.length} links · {source.model.joints.length} joints · metres</span></div>}

    {panel && <aside className="cutu-robot-panel" aria-label={panel === 'joints' ? 'Robot joints' : 'Robot settings'}>
      <div className="cutu-robot-panel-title"><strong>{panel === 'joints' ? 'Joints' : 'Robot settings'}</strong><IconButton label="Close robot panel" size="sm" onClick={() => setPanel(null)}><Glyph name="close" /></IconButton></div>
      {panel === 'joints' ? <>
        <p className="cutu-robot-help">{mode === 'inspect' ? 'Move joints to inspect the kinematic model.' : 'Motor targets take effect when physics advances.'}</p>
        {movableJoints.length ? movableJoints.map(joint => {
          const isLinear = joint.type === 'prismatic';
          const min = joint.limit?.lower ?? (isLinear ? -0.5 : -Math.PI);
          const max = joint.limit?.upper ?? (isLinear ? 0.5 : Math.PI);
          const value = targets[joint.name] ?? 0;
          const measured = snapshot?.joints[joint.name]?.position;
          return <div className="cutu-robot-joint" key={joint.name}>
            <div className="cutu-robot-joint-title"><strong>{joint.name}</strong><span>{joint.type}</span></div>
            <Slider label={joint.name} min={min} max={max} value={Math.min(max, Math.max(min, value))} step={isLinear ? 0.001 : 0.01} valueText={isLinear ? `${value.toFixed(3)} m` : `${(value * 180 / Math.PI).toFixed(1)}°`} disabled={mode === 'physics' && !ready} onValueChange={value => setTarget(joint.name, value)} />
            {mode === 'physics' && measured !== undefined && <p className="cutu-robot-joint-readout">Simulated: {isLinear ? `${measured.toFixed(3)} m` : `${(measured * 180 / Math.PI).toFixed(1)}°`}</p>}
            <span className="cutu-robot-joint-range">{isLinear ? `${min} to ${max} m` : `${(min * 180 / Math.PI).toFixed(0)}° to ${(max * 180 / Math.PI).toFixed(0)}°`}{joint.type === 'continuous' ? ' · continuous' : ' · URDF limits'}</span>
          </div>;
        }) : <p className="cutu-robot-help">This URDF has no movable joints.</p>}
        {selected && <div className="cutu-robot-link-details"><strong>{selected.name}</strong><span>{selected.inertial ? `${selected.inertial.mass} kg` : 'No declared mass'} · {selected.collisions.length} collision shapes</span></div>}
      </> : <>
        <SettingsRow title="Fixed base" description="Changing this restarts physics." control={<Switch aria-label="Fixed base" checked={fixedBase} onCheckedChange={setFixedBase} />} />
        <SettingsRow title="Ground plane" description="Contact surface at Z = 0 m." control={<Switch aria-label="Ground plane" checked={ground} onCheckedChange={setGround} />} />
        <SettingsRow title="Gravity" description="9.81 m/s² along −Z." control={<Switch aria-label="Gravity" checked={gravity} onCheckedChange={setGravity} />} />
        <SettingsRow title="Collision geometry" description="Show the collision shapes declared by the URDF." control={<Switch aria-label="Collision geometry" checked={colliders} onCheckedChange={value => { setColliders(value); viewport.current?.colliders(value); }} />} />
        {onOpenSource && <Button variant="filled" size="sm" onClick={onOpenSource}><Glyph name="code" />Open URDF source</Button>}
        {issues.length > 0 && <details className="cutu-robot-diagnostics"><summary>{issues.length} model {issues.length === 1 ? 'note' : 'notes'}</summary>{issues.map(issue => <p key={issue}>{issue}</p>)}</details>}
      </>}
    </aside>}

    {selectedLink && <div className="cutu-robot-selection"><span>Link</span><strong>{selectedLink}</strong><IconButton label="Clear robot selection" size="sm" onClick={() => { setSelectedLink(null); onSelection?.(null); }}><Glyph name="close" /></IconButton></div>}
    <div className="cutu-robot-bottom">
      {mode === 'physics' ? <div className="cutu-robot-simulation-controls" aria-label="Physics controls">
        <Button variant="filled" size="sm" disabled={!ready} aria-label={playing ? 'Pause physics' : 'Play physics'} onClick={() => setPlaying(!playing)}><Glyph name={playing ? 'stop' : 'play'} />{playing ? 'Pause' : 'Play'}</Button>
        <Button variant="ghost" size="sm" disabled={!ready || playing} onClick={step}>Step</Button>
        <Button variant="ghost" size="sm" disabled={!ready} onClick={reset}>Reset</Button>
        <output className="cutu-robot-time" data-testid="robot-snapshot" data-time={snapshot?.time ?? 0} data-root-position={rootPosition?.join(',') ?? ''} data-physics-snapshot={JSON.stringify(snapshot)}>{(snapshot?.time ?? 0).toFixed(2)} s</output>
      </div> : <div className="cutu-robot-inspect-note">Kinematic inspection <Button variant="ghost" size="sm" onClick={reset} disabled={!source}>Reset pose</Button></div>}
      <div className="cutu-robot-status" role="status" title={physicsError || undefined}><span className="cutu-robot-status-dot" />{mode === 'physics' ? <><strong>Simulated</strong><span>{physicsError ? 'Physics unavailable · see settings' : !ready ? 'Preparing physics…' : `${fixedBase ? 'Fixed' : 'Free'} base · ${gravity ? 'Gravity on' : 'Zero gravity'}${ground ? ` · ${snapshot?.contacts ?? 0} contacts` : ''}`}</span></> : <><strong>URDF</strong><span>Z-up · SI units</span></>}</div>
    </div>
  </section>;
}
