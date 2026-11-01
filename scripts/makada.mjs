import { triggerMakadaBuild } from './build-makada.mjs';
const [action = 'status', ...args] = process.argv.slice(2);
const base = 'http://127.0.0.1:4310';
async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error?.message ?? `HTTP ${r.status}`);
  return value;
}
function number(name, fallback, min, max) {
  const i = args.indexOf(`--${name}`), value = i < 0 ? fallback : Number(args[i+1]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}`);
  return value;
}
try {
  if (!['status','walk','stop','build'].includes(action)) throw new Error('Use status, walk, stop or build');
  const steps = number('steps',5,1,100), speed = number('speed',100,1,100), timeout = number('timeout',180,1,300);
  await api('GET','/api/health');
  const projects = await api('GET','/api/projects');
  const project = projects.find(p=>p.name==='Makada Demo') ?? projects.find(p=>p.name==='Makada');
  if (!project) throw new Error('Makada project not found');
  const path = `/api/projects/${encodeURIComponent(project.id)}`;
  const active = (await api('GET',path+'/operations')).filter(o=>o.status==='running');
  if (action==='status') console.log(`Workspace ready: ${base}/ | ${project.name} | ${active.length} active operations. Controller power is not verified by this command.`);
  if (action==='stop') {
    for (const op of active) await api('POST',`${path}/operations/${op.id}/cancel`,{});
    console.log(`Cancelled ${active.length} active operations. No new motion sent.`);
  }
  if (action==='build') console.log('Build Makada:',(await triggerMakadaBuild({projectId:project.id})).status);
  if (action==='walk') {
    if (active.length) throw new Error('An operation is active; stop it first.');
    let op = await api('POST',path+'/operations',{capabilityId:'walk',inputs:{steps,speed,durationSeconds:timeout,telemetryHz:2}});
    console.log(`Sent ${steps} cycles, speed ${speed}. Stop: node scripts/makada.mjs stop`);
    const deadline = Date.now()+(timeout+15)*1000;
    let last='';
    while (op.status==='running' && Date.now()<deadline) {
      await new Promise(r=>setTimeout(r,300));
      op = (await api('GET',path+'/operations')).find(o=>o.id===op.id);
      if (!op) throw new Error('Operation disappeared. Do not repeat automatically.');
      for (const line of op.output.split('\n').reverse()) {
        try {
          const p=JSON.parse(line).walkProgress;
          if (!p) continue;
          const label=`${p.completedCycles}/${p.requestedCycles} cycles`;
          if (label!==last) {console.log(label);last=label;}
          break;
        } catch {}
      }
    }
    if (op.status==='running') {
      await api('POST',`${path}/operations/${op.id}/cancel`,{});
      throw new Error('Deadline reached; cancelled. No retry.');
    }
    console.log('Run:',op.status);
    if (op.status!=='succeeded') process.exitCode=1;
  }
} catch (error) {
  console.error(error.message, '\nNo automatic retry. If offline, start Start-Workspace.ps1 -SkipBuild.');
  process.exitCode=1;
}
