import {test,expect} from '@playwright/test';
test('real robot control sends exact cycle count and exposes stop without starting hardware in this UI fixture',async({page,request})=>{
 const created=await request.post('/api/projects',{data:{name:'Robot control UI fixture',template:'spidey'}});expect(created.ok()).toBeTruthy();const project=await created.json();
 await page.addInitScript(id=>localStorage.setItem('cutucircuits:active-project',id),project.id);
 await page.goto('/');
 const controls=page.getByRole('region',{name:'Real robot controls'});
 await expect(controls).toBeVisible();
 const cycles=controls.getByRole('spinbutton',{name:'Gait cycles',exact:true});
 await cycles.fill('101');await expect(controls.getByRole('button',{name:'Walk forward',exact:true})).toBeDisabled();
 await cycles.fill('50');
 let payload:any;let stopped=false;
 const operation={id:'ui-fixture-no-hardware',projectId:project.id,capabilityId:'walk',label:'Walk forward',status:'running',startedAt:new Date().toISOString(),output:JSON.stringify({walkProgress:{requestedCycles:50,completedCycles:20}})+'\n',telemetry:{source:'device',state:{running:1,enabled_mask:7},receivedAtUnixMs:Date.now(),staleAfterMs:1500,telemetryStale:false}};
 await page.route('**/api/projects/*/operations',async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}
  payload=route.request().postDataJSON();await route.fulfill({json:operation});
 });
 await page.route('**/api/projects/*/operations/*/cancel',async route=>{stopped=true;await route.fulfill({json:{...operation,status:'cancelled'}});});
 await controls.getByRole('button',{name:'Walk forward',exact:true}).click();
 await expect(controls).toContainText('20 / 50 cycles');
 expect(payload).toEqual({capabilityId:'walk',inputs:{steps:50,speed:100,durationSeconds:180,telemetryHz:2}});
 await expect(controls.getByRole('button',{name:'Stop robot',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'Circuit',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stop active robot',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Stop active robot',exact:true}).click();
 await page.getByRole('tab',{name:'Assembly',exact:true}).click();
 await expect(controls).toContainText('Stopped');expect(stopped).toBe(true);
 const actualOperations=await request.get(`/api/projects/${project.id}/operations`);expect(await actualOperations.json()).toEqual([]);
});
