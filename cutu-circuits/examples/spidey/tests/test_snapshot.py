"""Atomic snapshot protocol integration against fake TCP only; no physical robot."""
import json
import socket
import time
import unittest
import test_broker as broker

class SnapshotDevice(broker.FakeDevice):
    def __init__(self, mode='normal'):
        self.mode = mode
        self.snapshot_times = []
        super().__init__()

    def serve(self):
        sequence = 0
        try:
            conn, _ = self.server.accept()
            self.connections += 1
            with conn:
                conn.settimeout(4)
                with conn.makefile('rb') as stream:
                    for raw in stream:
                        command = raw.decode().strip()
                        self.commands.append(command)
                        if command.startswith('AUTH '):
                            reply = 'OK AUTH'
                        elif command == 'SNAPSHOT':
                            self.snapshot_times.append(time.monotonic())
                            sequence += 1
                            if self.mode == 'slow':
                                time.sleep(.6)
                            elif self.mode == 'delayed':
                                time.sleep(1.2)
                            elif self.mode == 'timeout':
                                time.sleep(2.3)
                            device_sequence = 1 if self.mode == 'repeated' else sequence
                            reply = f'SNAPSHOT seq={device_sequence} uptime_ms={sequence * 100} phase={sequence % 8} action=0 step=0 running=0 enabled=1 enabled_mask=7 calibrated=1 queued=0 commanded=1450,1500,1505'
                        else:
                            reply = 'OK ' + command.split()[0]
                        conn.sendall((reply + '\n').encode())
        except (OSError, TimeoutError):
            pass
        finally:
            self.server.close()

class SnapshotTests(unittest.TestCase):
    launch = broker.BrokerTest.launch
    def test_delayed_reply_over_one_second_is_received_once_without_resend(self):
        device = SnapshotDevice('delayed')
        proc = self.launch(device, 'status', {})
        stdout, stderr = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertEqual(device.commands.count('SNAPSHOT'), 1)
        self.assertIn('"state"', stdout)
        self.assertEqual(device.commands[-1], 'STOP')
        self.assertEqual(device.connections, 1)

    def test_deadline_failure_never_retries_and_stops_on_owned_connection(self):
        device = SnapshotDevice('timeout')
        started = time.monotonic()
        proc = self.launch(device, 'status', {})
        stdout, stderr = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 1, stderr)
        self.assertIn('Device reply timed out', stdout)
        self.assertIn('stop-acknowledged', stdout)
        self.assertEqual(device.commands.count('SNAPSHOT'), 1)
        self.assertEqual(device.commands[-1], 'STOP')
        self.assertLess(time.monotonic()-started, 4.5)
        self.assertEqual(device.connections, 1)

    def test_two_hz_monitor_retains_freshness_and_bounded_polling(self):
        device = SnapshotDevice()
        proc = self.launch(device, 'connect', {'durationSeconds': 1, 'telemetryHz': 2})
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 0, stderr)
        snapshots = [json.loads(line) for line in stdout.splitlines() if '"state"' in line]
        self.assertGreaterEqual(len(snapshots), 2)
        self.assertLessEqual(len(snapshots), 3)
        self.assertTrue(all(record['staleAfterMs'] == 1500 for record in snapshots))
        self.assertTrue(all(b-a >= .4 for a,b in zip(device.snapshot_times, device.snapshot_times[1:])))
        self.assertEqual(device.commands[-1], 'STOP')
    # Reuse only the subprocess fixture; legacy tests run in their own module.
    def test_atomic_snapshot_timestamp_phase_pulses_and_bounded_rate(self):
        device = SnapshotDevice()
        proc = self.launch(device, 'connect', {'durationSeconds': 1, 'telemetryHz': 10})
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 0, stderr)
        snapshots = [json.loads(line) for line in stdout.splitlines() if '"state"' in line]
        self.assertGreaterEqual(len(snapshots), 6)
        self.assertLessEqual(len(snapshots), 12)
        self.assertNotIn('STATUS', device.commands)
        self.assertNotIn('DIAG', device.commands)
        for index, record in enumerate(snapshots, 1):
            self.assertTrue(record['snapshotAtomic'])
            self.assertFalse(record['telemetryStale'])
            self.assertEqual(record['sequence'], index)
            self.assertEqual(record['state']['phase'], index % 8)
            self.assertEqual(record['deviceUptimeMs'], index * 100)
            self.assertLess(abs(time.time()*1000-record['receivedAtUnixMs']), 4000)
            self.assertEqual(record['commandedPulseUs']['servo-left'], 1450)
            self.assertEqual(record['shaftPosition'], 'unmeasured')
        self.assertTrue(all(b-a >= .07 for a,b in zip(device.snapshot_times, device.snapshot_times[1:])))
        self.assertEqual(device.commands[-1], 'STOP')
        self.assertEqual(device.connections, 1)

    def test_slow_snapshot_is_explicitly_stale(self):
        device = SnapshotDevice('slow')
        proc = self.launch(device, 'status', {'telemetryHz': 10})
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 0, stderr)
        record = next(json.loads(line) for line in stdout.splitlines() if '"state"' in line)
        self.assertTrue(record['telemetryStale'])
        self.assertGreater(record['roundTripMs'], record['staleAfterMs'])
        self.assertEqual(device.commands[-1], 'STOP')

    def test_repeated_snapshot_invalidates_before_owned_stop(self):
        device = SnapshotDevice('repeated')
        proc = self.launch(device, 'connect', {'durationSeconds': 2, 'telemetryHz': 20})
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 1, stderr)
        records = [json.loads(line) for line in stdout.splitlines()]
        self.assertTrue(any(record.get('telemetryStale') and record.get('synchronization') == 'unavailable' for record in records))
        self.assertIn('stale snapshot sequence', stdout)
        self.assertEqual(device.commands[-1], 'STOP')

    def test_legacy_fallback_probes_once_and_marks_non_atomic(self):
        device = broker.FakeDevice()
        proc = self.launch(device, 'connect', {'durationSeconds': 1, 'telemetryHz': 10})
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(proc.returncode, 0, stderr)
        snapshots = [json.loads(line) for line in stdout.splitlines() if '"state"' in line]
        self.assertGreaterEqual(len(snapshots), 6)
        self.assertEqual(device.commands.count('SNAPSHOT'), 1)
        self.assertTrue(all(not record['snapshotAtomic'] for record in snapshots))
        self.assertTrue(all(record['deviceUptimeMs'] is None for record in snapshots))
        self.assertEqual(device.commands[-1], 'STOP')

