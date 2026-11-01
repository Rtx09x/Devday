import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('walk_plan_test_adapter',Path(__file__).resolve().parents[1]/'programs/spidey.py')
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
class Fake:
    def __init__(self,fail_run=False):self.commands=[];self.fail_run=fail_run
    def command(self,command):
        self.commands.append(command)
        if command=='RUN' and self.fail_run:raise TimeoutError('Lost reply')
        return 'OK ADD' if command.startswith('ADD ') else 'OK RUN' if command=='RUN' else 'OK'
class WalkPlanTest(unittest.TestCase):
    def test_hundred_cycles_remain_five_verified_twenty_cycle_queues(self):
        plan=adapter.WalkPlan(dict(steps=100,speed=100,durationSeconds=180));session=Fake()
        with patch.object(adapter.time,'sleep'),patch.object(adapter,'emit'):
            for index in range(5):
                plan.start_batch(session)
                self.assertEqual(plan.active,20)
                self.assertEqual(plan.progress(dict(running=1,step=7))['completedCycles'],index*20+7)
                self.assertEqual(plan.finish_batch(dict(running=0,action=1)),index==4)
        self.assertEqual(plan.completed,100)
        self.assertEqual(session.commands.count('RUN'),5)
        self.assertEqual(sum(c=='ADD 100 100 20 100' for c in session.commands),5)
    def test_invalid_count_is_rejected_before_any_motion(self):
        for count in (0,101,1.5,True):
            with self.assertRaises(ValueError):adapter.WalkPlan(dict(steps=count,speed=100,durationSeconds=180))
    def test_missing_run_ack_is_never_resent_or_counted(self):
        plan=adapter.WalkPlan(dict(steps=50,speed=100,durationSeconds=180));session=Fake(True)
        with patch.object(adapter.time,'sleep'),patch.object(adapter,'emit'),self.assertRaises(TimeoutError):plan.start_batch(session)
        self.assertEqual(session.commands.count('RUN'),1)
        self.assertEqual(plan.completed,0)
        with self.assertRaises(RuntimeError):plan.finish_batch(dict(running=0,action=0))
        self.assertEqual(plan.completed,0)
    def test_deadline_expires_before_sending_any_next_batch(self):
        plan=adapter.WalkPlan(dict(steps=50,speed=100,durationSeconds=180));plan.deadline=0;session=Fake()
        with self.assertRaises(TimeoutError):plan.start_batch(session)
        self.assertEqual(session.commands,[])


class WalkPlanIntegrationTest(unittest.TestCase):
    def test_fifty_cycle_request_runs_three_verified_queues_on_one_tcp_connection(self):
        import json,os,socket,subprocess,sys,tempfile,threading
        from test_broker import FakeDevice,PROJECT
        class Queues(FakeDevice):
            def __init__(self):
                self.seq=0;self.mask=0;self.running=False;self.polls=0;self.action=0
                super().__init__()
            def serve(self):
                try:
                    conn,_=self.server.accept();self.connections+=1
                    with conn:
                        conn.settimeout(4)
                        with conn.makefile('rb') as stream:
                            for raw in stream:
                                command=raw.decode().strip();self.commands.append(command)
                                verb=command.split()[0]
                                if verb=='STOP':self.mask=0;self.running=False
                                if verb=='CLEAR':self.action=0
                                if verb=='ENABLE':self.mask|=1<<(int(command.split()[1])-1)
                                if verb=='RUN':self.running=True;self.polls=0;self.action=0
                                if verb=='SNAPSHOT':
                                    self.seq+=1
                                    if self.running:
                                        self.polls+=1
                                        if self.polls>=2:self.running=False;self.action=1;self.mask=0
                                    reply=f'SNAPSHOT seq={self.seq} uptime_ms={1000+self.seq*100} phase=0 action={self.action} step=0 running={int(self.running)} enabled={int(bool(self.mask))} enabled_mask={self.mask} calibrated=1 queued=1 commanded=1450,1500,1505'
                                else:reply='OK '+verb
                                conn.sendall((reply+'\n').encode())
                except (OSError,TimeoutError):pass
                finally:self.server.close()
        device=Queues()
        with tempfile.TemporaryDirectory() as temp:
            config=Path(temp)/'wifi.json';config.write_text(json.dumps(dict(host='127.0.0.1',port=device.port,token='fake-test-only')))
            env=dict(os.environ,SPIDEY_CONFIG=str(config))
            run=subprocess.run([sys.executable,str(PROJECT/'programs/spidey.py'),'walk'],input=json.dumps(dict(steps=50,speed=100,durationSeconds=30,telemetryHz=2)),text=True,capture_output=True,env=env,cwd=PROJECT,timeout=25)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        self.assertEqual(device.connections,1)
        self.assertEqual([int(c.split()[3]) for c in device.commands if c.startswith('ADD ')],[20,20,10])
        self.assertEqual(device.commands.count('RUN'),3)
        records=[json.loads(line) for line in run.stdout.splitlines()]
        done=[r for r in records if r.get('event')=='walk-completed']
        self.assertEqual(len(done),1)
        self.assertEqual(done[0]['walkProgress']['completedCycles'],50)
        self.assertEqual(device.commands[-1],'STOP')

if __name__=='__main__':unittest.main()

