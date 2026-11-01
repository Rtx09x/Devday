import { useEffect, useRef, useState } from 'react';
import type { Asset, Project } from '@cutucircuits/core';
import { parseUrdf } from '@cutucircuits/robotics';
import { Button, Dialog, Input } from '@cutucircuits/ui';
import { api } from '../api';
import { projectPath } from './projectResources';
import './robotics.css';

interface Props {
  project: Project;
  onImported: (asset: Asset) => void | Promise<void>;
  onClose: () => void;
}

export default function RobotImportDialog({ project, onImported, onClose }: Props) {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRead = useRef(0);
  useEffect(() => () => { fileRead.current++; }, []);
  const readFile = async (file: File | undefined) => {
    const request = ++fileRead.current;
    setError('');
    setContent('');
    setPreview('');
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a URDF source smaller than 1 MB. Meshes stay as separate project files.');
      const xml = await file.text();
      if (request !== fileRead.current) return;
      const model = parseUrdf(xml);
      setContent(xml);
      setName(model.name);
      setPath(file.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
      setPreview(`${model.name} · ${model.links.length} links · ${model.joints.length} joints`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const submit = async () => {
    setError('');
    try {
      const destination = projectPath(path.trim());
      if (!/\.(urdf|xml)$/i.test(destination)) throw new Error('Use a .urdf or .xml project path.');
      if (!content) throw new Error('Choose a URDF file first.');
      setBusy(true);
      const result = await api<{ asset: Asset }>(`/projects/${encodeURIComponent(project.id)}/robotics/import`, { path: destination, content, name: name.trim() || undefined });
      await onImported(result.asset);
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <Dialog open title="Import URDF" onOpenChange={open => { if (!open && !busy) onClose(); }} className="workspace-dialog" containerClassName="workspace-dialog-container">
    <form className="dialog-inner cutu-robot-import-content" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>Open a native robot model with articulated joints and physics.</p>
      <label>Robot file<Input type="file" accept=".urdf,.xml,application/xml,text/xml" aria-label="URDF file" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} /></label>
      {preview && <p role="status">{preview}</p>}
      <label>Name<Input value={name} onChange={event => setName(event.target.value)} placeholder="Robot name" disabled={busy || !content} /></label>
      <label>Project path<Input value={path} onChange={event => setPath(event.target.value)} placeholder="robots/robot.urdf" disabled={busy || !content} /></label>
      <p>Mesh companion files must already be in this project. Relative paths resolve beside the URDF. For <code>package://name/…</code>, keep files under the project’s <code>name/</code> folder.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions"><Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="filled" size="sm" disabled={busy || !content || !path.trim()}>{busy ? 'Importing…' : 'Import robot'}</Button></div>
    </form>
  </Dialog>;
}
