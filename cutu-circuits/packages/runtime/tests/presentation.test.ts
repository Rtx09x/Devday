import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRuntime} from '../src/server.ts';

test('presentation tool requires project-bound view acknowledgment and never edits or actuates',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cutu-presentation-'));
 const runtime=await createRuntime({dataDir:dir,seed:false,pollIntervalMs:0,port:0});
 try{
  const project=await runtime.store.create('Makada show','spidey');
  const other=await runtime.store.create('Other view','blank');
  const original=await runtime.store.read(project.id,'model.replicad.ts');
  const server=await runtime.listen();const address=server.address();assert(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}/api/projects/`;
  const post=(id:string,suffix:string,body:unknown)=>fetch(base+id+'/presentation/'+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let received:any;let wrongProjectStatus=0;
  const unsubscribe=runtime.store.events.subscribe(project.id,event=>{
   if(event.type!=='presentation.requested')return;
   received=event.data;
   void(async()=>{
    wrongProjectStatus=(await post(other.id,'ack',{requestId:received.requestId,status:'started'})).status;
    await post(project.id,'ack',{requestId:received.requestId,status:received.action==='stop'?'stopped':'started'});
   })();
  });
  const start=await post(project.id,'build',{});assert.equal(start.status,200);
  const payload=await start.json();assert.equal(payload.status,'started');assert.equal(payload.hardwareCommandsSent,false);assert.equal(wrongProjectStatus,404);
  assert.equal((await post(project.id,'ack',{requestId:payload.requestId,status:'started'})).status,404);
  assert.equal((await post(project.id,'build',{action:'stop'})).status,200);
  assert.equal((await post(project.id,'build',{action:'walk'})).status,400);
  assert.equal((await runtime.store.read(project.id,'model.replicad.ts')).sha256,original.sha256);
  assert.equal((await runtime.store.get(project.id)).revision,project.revision);
  assert.deepEqual(runtime.runner.list(project.id),[]);
  unsubscribe();
  const absent=await post(project.id,'build',{action:'start'});assert.equal(absent.status,409);
  assert.equal((await absent.json()).error.code,'PRESENTATION_VIEW_UNAVAILABLE');
 } finally{
  await runtime.close();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('cutu-presentation-'));
  await rm(dir,{recursive:true,force:true});
 }
});
