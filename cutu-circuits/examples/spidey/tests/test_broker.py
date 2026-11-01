"""Protocol tests use a fake TCP server, never a physical robot."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

PROJECT = Path(__file__).resolve().parents[1]

class FakeDevice:
    def __init__(self, error=False):
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen()
        self.server.settimeout(3)
        self.port = self.server.getsockname()[1]
        self.commands = []
        self.connections = 0
        self.error = error
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        try:
            conn, _ = self.server.accept()
            self.connections += 1
            with conn:
                conn.settimeout(3)
                with conn.makefile('rb') as stream:
                    for raw in stream:
                        command = raw.decode().strip()
                        self.commands.append(command)
                        if command.startswith('AUTH '):
                            reply = 'OK AUTH'
                        elif command == 'STATUS':
                            reply = 'STATUS enabled=1 enabled_mask=7 running=0 calibrated=1 queued=1 action=1 step=0 phase=0 ip=192.0.2.1'
                        elif command == 'SNAPSHOT':
                            reply = 'ERR command'  # Legacy firmware has no atomic snapshot.
                        elif command == 'DIAG':
                            reply = 'DIAG commanded=1450,1500,1505 library_us=1450,1500,1505 enabled_mask=7'
                        elif self.error and command == 'RUN':
                            reply = 'ERR not_calibrated'
                        else:
                            reply = 'OK ' + command.split()[0]
                        if command == 'DIAG':
                            conn.sendall(b'DONE\n')  # Drain async completion before reply.
                        conn.sendall((reply + '\n').encode())
        except (OSError, TimeoutError):
            pass
        finally:
            self.server.close()

class BrokerTest(unittest.TestCase):
    def launch(self, device, action, inputs):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name) / 'wifi.json'
        path.write_text(json.dumps({'host': '127.0.0.1', 'port': device.port, 'token': 'private-test-token'}))
        env = {**os.environ, 'SPIDEY_CONFIG': str(path)}
        proc = subprocess.Popen([sys.executable, 'programs/spidey.py', action], cwd=PROJECT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        proc.stdin.write(json.dumps(inputs) + '\n')
        proc.stdin.flush()
        return proc

    def test_status_actual_replies_and_stop_on_same_connection(self):
        device = FakeDevice()
        proc = self.launch(device, 'status', {})
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 0, stderr)
        records = [json.loads(x) for x in stdout.splitlines()]
        state = next(x for x in records if 'state' in x)
        self.assertEqual(state['commandedPulseUs']['servo-left'], 1450)
        self.assertEqual(state['shaftPosition'], 'unmeasured')
        self.assertNotIn('private-test-token', stdout + stderr)
        self.assertEqual(device.connections, 1)
        self.assertEqual(device.commands[-1], 'STOP')
        self.assertIn('DIAG', device.commands)
        device.thread.join(2)

    def test_monitor_cancel_stops_using_owned_connection(self):
        device = FakeDevice()
        proc = self.launch(device, 'connect', {'durationSeconds': 30})
        deadline = time.monotonic() + 3
        while 'DIAG' not in device.commands and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertIn('STATUS', device.commands)
        if os.name == 'nt':
            # Windows SIGTERM terminates immediately; the runtime uses JSONL for graceful STOP.
            proc.stdin.write('{"type":"cancel"}\n')
            proc.stdin.flush()
        else:
            proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=2)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertIn('stop-acknowledged', stdout)
        self.assertEqual(device.connections, 1)
        self.assertEqual(device.commands[-1], 'STOP')
        device.thread.join(2)

    def test_jsonl_cancel_stops_without_os_signal(self):
        device = FakeDevice()
        proc = self.launch(device, 'connect', {'durationSeconds': 30})
        deadline = time.monotonic() + 3
        while 'DIAG' not in device.commands and time.monotonic() < deadline:
            time.sleep(.01)
        proc.stdin.write('{"type":"cancel"}\n')
        proc.stdin.flush()
        stdout, stderr = proc.communicate(timeout=2)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertIn('stop-acknowledged', stdout)
        self.assertEqual(device.commands[-1], 'STOP')
        self.assertEqual(device.connections, 1)
        device.thread.join(2)

    def test_monitor_walk_control_reuses_connection(self):
        device = FakeDevice()
        proc = self.launch(device, 'connect', {'durationSeconds': 30})
        deadline = time.monotonic() + 3
        while 'DIAG' not in device.commands and time.monotonic() < deadline:
            time.sleep(.01)
        proc.stdin.write(json.dumps({'type': 'walk', 'steps': 0, 'speed': 100, 'durationSeconds': 5}) + '\n')
        proc.stdin.write(json.dumps({'type': 'walk', 'steps': 1, 'speed': 100, 'durationSeconds': 5}) + '\n')
        proc.stdin.flush()
        deadline = time.monotonic() + 4
        while 'RUN' not in device.commands and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertIn('RUN', device.commands)
        proc.stdin.write('{"type":"stop"}\n')
        proc.stdin.flush()
        time.sleep(.6)
        proc.stdin.write('{"type":"cancel"}\n')
        proc.stdin.flush()
        stdout, stderr = proc.communicate(timeout=2)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertIn('Walk control requires', stdout)
        self.assertEqual(len([x for x in device.commands if x.startswith('ADD ')]), 1)
        self.assertEqual(device.connections, 1)
        self.assertEqual(device.commands[-1], 'STOP')
        device.thread.join(2)

    def test_walk_error_still_stops_same_connection(self):
        device = FakeDevice(error=True)
        proc = self.launch(device, 'walk', {'steps': 1, 'speed': 100, 'durationSeconds': 5})
        stdout, stderr = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 1)
        self.assertIn('not_calibrated', stdout)
        self.assertEqual(device.commands[-1], 'STOP')
        self.assertEqual(device.connections, 1)
        device.thread.join(2)

    def test_missing_credentials_is_honest_failure(self):
        env = {**os.environ, 'SPIDEY_CONFIG': '/nonexistent/cutu-credentials.json'}
        proc = subprocess.run([sys.executable, 'programs/spidey.py', 'status'], cwd=PROJECT, env=env, input='{}\n', text=True, capture_output=True, timeout=3)
        self.assertEqual(proc.returncode, 1)
        self.assertIn('Local credentials missing', proc.stdout)
        self.assertNotIn('source": "device', proc.stdout)

if __name__ == '__main__':
    unittest.main()
