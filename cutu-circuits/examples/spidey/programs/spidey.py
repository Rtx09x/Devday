"""Cutu Circuits Makada adapter. One process owns one authenticated TCP session.
Adapted from Rtx09x/cutie-circuits-spidey tools/hexapod.py and onboard_walk.py.
Credentials stay in SPIDEY_CONFIG or .local/wifi.json; they are never telemetry.
"""
import json
import os
import queue
from pathlib import Path
import signal
import socket
import sys
import threading
import time

stopping = False
controls_queue = queue.Queue(maxsize=32)
# One request, no resend: tolerate hotspot jitter while remaining below the
# firmware's three-second command watchdog. Poll intervals add at most .5 s.
REPLY_TIMEOUT_SECONDS = 2.0

def stop_requested(*_):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop_requested)
signal.signal(signal.SIGINT, stop_requested)

def emit(**data):
    print(json.dumps(data), flush=True)

class Session:
    def __init__(self, config):
        self.sock = socket.create_connection((config['host'], int(config.get('port', 8266))), timeout=3)
        self.sock.settimeout(.2)
        self.buffer = b''
        self.snapshot_supported = None
        self.sequence = 0
        self.last_device_sequence = None
        self.last_device_uptime = None
        self.stale_after_ms = 500
        self.walk_plan = None
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        reply = self.command('AUTH ' + config['token'])
        if reply != 'OK AUTH':
            raise RuntimeError('Device authentication failed')

    def command(self, command, cleanup=False, allow_unsupported=False):
        if stopping and not cleanup:
            raise InterruptedError('Stop requested')
        self.sock.sendall((command + '\n').encode('ascii'))
        deadline = time.monotonic() + REPLY_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if stopping and not cleanup:
                raise InterruptedError('Stop requested')
            if b'\n' not in self.buffer:
                self.sock.settimeout(min(.2, max(.001, deadline - time.monotonic())))
                try:
                    chunk = self.sock.recv(4096)
                except socket.timeout:
                    continue
                if not chunk:
                    raise ConnectionError('Device disconnected')
                self.buffer += chunk
                if len(self.buffer) > 65536:
                    raise RuntimeError('Device reply exceeds limit')
                continue
            line, self.buffer = self.buffer.split(b'\n', 1)
            reply = line.decode('ascii').strip()
            if reply == 'DONE':
                emit(source='device', event='queue-completed')
                continue
            if cleanup and reply != 'OK STOP':
                continue
            if reply.startswith('ERR'):
                if allow_unsupported and reply == 'ERR command':
                    return reply
                raise RuntimeError('Device rejected command: ' + reply[:100])
            return reply
        raise TimeoutError('Device reply timed out')

    def status(self):
        started = time.monotonic()
        atomic = self.snapshot_supported is not False
        reply = self.command('SNAPSHOT', allow_unsupported=True) if atomic else ''
        if atomic and reply == 'ERR command':
            self.snapshot_supported = False
            atomic = False
        elif atomic:
            if not reply.startswith('SNAPSHOT '):
                raise RuntimeError('Unexpected snapshot reply')
            self.snapshot_supported = True
        if not atomic:
            reply = self.command('STATUS')
            if not reply.startswith('STATUS '):
                raise RuntimeError('Unexpected status reply')
        fields = {}
        for item in reply.split()[1:]:
            if '=' in item:
                key, value = item.split('=', 1)
                if key != 'ip':
                    fields[key] = int(value) if value.lstrip('-').isdigit() else value
        diag = reply if atomic else self.command('DIAG')
        if not atomic and not diag.startswith('DIAG '):
            raise RuntimeError('Unexpected diagnostic reply')
        pulse_field = next((x.split('=', 1)[1] for x in diag.split() if x.startswith('commanded=')), '')
        pulses = [int(x) for x in pulse_field.split(',')] if pulse_field else []
        if len(pulses) != 3 or any(not 900 <= pulse <= 2100 for pulse in pulses):
            raise RuntimeError('Invalid commanded pulse snapshot')
        if fields.get('phase') not in range(8) or fields.get('enabled_mask') not in range(8):
            raise RuntimeError('Invalid phase or enabled mask')
        if atomic:
            seq, uptime = fields.get('seq'), fields.get('uptime_ms')
            if type(seq) is not int or type(uptime) is not int or not 0 <= seq <= 0xffffffff or not 0 <= uptime <= 0xffffffff:
                raise RuntimeError('Invalid snapshot clock')
            if self.last_device_sequence is not None and not 0 < ((seq - self.last_device_sequence) & 0xffffffff) < 0x80000000:
                raise RuntimeError('Repeated or out-of-order stale snapshot sequence')
            if self.last_device_uptime is not None and ((uptime - self.last_device_uptime) & 0xffffffff) >= 0x80000000:
                raise RuntimeError('Device clock moved backward; reconnect required')
            self.last_device_sequence, self.last_device_uptime = seq, uptime
        else:
            self.sequence += 1
            seq, uptime = self.sequence, None
        elapsed_ms = (time.monotonic() - started) * 1000
        stale = elapsed_ms > self.stale_after_ms
        emit(walkProgress=self.walk_plan.progress(fields) if self.walk_plan else None, source='device', state=fields, commandedPulseUs=dict(zip(['servo-left', 'servo-right', 'servo-tilt'], pulses)), shaftPosition='unmeasured', synchronization='commanded-pulses', receivedAtUnixMs=int(time.time() * 1000), staleAfterMs=self.stale_after_ms, telemetryStale=stale, snapshotAtomic=atomic, sequence=seq, deviceUptimeMs=uptime, roundTripMs=round(elapsed_ms, 1))
        return fields

    def close(self):
        try:
            self.command('STOP', cleanup=True)
            emit(source='device', event='stop-acknowledged')
        finally:
            self.sock.close()

def center_servos(session):
    """Center only; retain the owned heartbeat session to hold enabled outputs."""
    session.command('STOP')
    session.command('CLEAR')
    for joint in (1, 2, 3):
        session.command(f'ENABLE {joint}')
        time.sleep(.6)
        session.command('PING')
    emit(source='device', event='center-command-acknowledged', shaftPosition='unmeasured')


class WalkPlan:
    """A bounded user request, split into verified MCU queues; never resend a batch."""
    def __init__(self, request):
        for key, minimum, maximum in [('steps', 1, 100), ('speed', 1, 100), ('durationSeconds', 1, 300)]:
            value = request.get(key)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError('Walk control requires 1-100 cycles, speed 1-100 and duration 1-300 seconds')
        self.total = request['steps']
        self.speed = request['speed']
        self.deadline = time.monotonic() + request['durationSeconds']
        self.completed = self.observed = self.active = self.batch = 0
        self.cancelled = False

    def progress(self, state=None):
        count = self.completed
        if state and self.active:
            step = state.get('step', 0)
            count += self.active if state.get('running') == 0 and state.get('action') == 1 else max(0, min(self.active, step if type(step) is int else 0))
        self.observed = max(self.observed, count)
        return dict(requestedCycles=self.total, completedCycles=self.observed, batch=self.batch,
                    batchCycles=self.active, cancelled=self.cancelled)

    def start_batch(self, session):
        if time.monotonic() >= self.deadline:
            raise TimeoutError('Walk duration exceeded before next batch; no RUN sent')
        self.active = min(20, self.total - self.completed)
        if self.active <= 0:
            raise RuntimeError('No pending walk cycles')
        session.command('STOP')
        session.command('CLEAR')
        if session.command(f'ADD 100 100 {self.active} {self.speed}') != 'OK ADD':
            raise RuntimeError('Queue acknowledgement mismatch; no RUN sent')
        for joint in (1, 2, 3):
            if time.monotonic() >= self.deadline:
                raise TimeoutError('Walk duration exceeded before RUN')
            session.command(f'ENABLE {joint}')
            time.sleep(.6)
            session.command('PING')
        if session.command('RUN') != 'OK RUN':
            raise RuntimeError('Run acknowledgement mismatch; do not resend')
        self.batch += 1
        emit(source='device', event='walk-started', steps=self.active, speed=self.speed,
             runAcknowledged=True, walkProgress=self.progress())

    def finish_batch(self, state):
        if state.get('running') != 0 or state.get('action') != 1:
            raise RuntimeError('Device stopped before completing the queue')
        self.completed += self.active
        self.active = 0
        self.observed = self.completed
        return self.completed == self.total


def preview(inputs):
    profile = json.loads(Path('profiles/spidey-last-known.json').read_text())
    centers = [j['center'] for j in profile['joints']]
    targets = [(2, 1645), (1, 1740), (2, 1505), (0, 1600), (2, 1345), (0, 1260), (2, 1505), (1, 1350)]
    for phase, (joint, pulse) in enumerate(targets):
        centers[joint] = pulse
        emit(source='offline-preview', calibrated=False, phase=phase, commandedPulseUs=dict(zip(['servo-left', 'servo-right', 'servo-tilt'], centers)), note='Illustrative kinematics; last-known profile, not measured position')
        if stopping:
            break
        time.sleep(float(inputs.get('phaseMs', 150)) / 1000)

def main():
    inputs = json.loads(sys.stdin.readline() or '{}')
    def controls():
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if message.get('type') == 'cancel':
                    stop_requested()
                else:
                    controls_queue.put_nowait(message)
            except (ValueError, AttributeError, queue.Full):
                emit(source='adapter', error='Invalid control record or control queue full')
    threading.Thread(target=controls, daemon=True).start()
    action = sys.argv[1] if len(sys.argv) > 1 else 'inspect'
    if action == 'inspect':
        emit(source='project-files', controller='NodeMCU ESP8266', protocol='authenticated ASCII TCP / 8266', pins={'servo-left': 14, 'servo-right': 12, 'servo-tilt': 13}, feedback='No measured shaft position', calibration=json.loads(Path('profiles/spidey-last-known.json').read_text()))
        return
    if action == 'preview':
        preview(inputs)
        return
    path = Path(os.environ.get('SPIDEY_CONFIG', '.local/wifi.json')).expanduser()
    if not path.is_file():
        raise RuntimeError('Local credentials missing. Create .local/wifi.json with host and token, or set SPIDEY_CONFIG. See README.md.')
    config = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(config.get('host'), str) or not isinstance(config.get('token'), str) or any(c in config['token'] for c in '\r\n'):
        raise RuntimeError('Local credential file requires a host and single-line token')
    session = Session(config)
    try:
        telemetry_hz = inputs.get('telemetryHz', config.get('telemetryHz', 2))
        if type(telemetry_hz) not in (int, float) or not 1 <= telemetry_hz <= 20:
            raise ValueError('telemetryHz must be between 1 and 20')
        poll_seconds = 1 / telemetry_hz
        session.stale_after_ms = max(500, int(poll_seconds * 3000))
        emit(source='device', event='authenticated', transport='tcp')
        if action == 'status':
            session.status()
            return
        plan = WalkPlan(inputs) if action == 'walk' else None
        session.walk_plan = plan
        if plan:
            plan.start_batch(session)
        walking = plan is not None
        walk_deadline = plan.deadline if plan else None
        deadline = time.monotonic() + float(inputs.get('durationSeconds', 300))
        while not stopping and time.monotonic() < deadline:
            try:
                message = controls_queue.get_nowait()
            except queue.Empty:
                message = None
            if message:
                kind = message.get('type')
                if kind == 'walk':
                    try:
                        if walking:
                            raise ValueError('A walk is already running; send stop first')
                        plan = WalkPlan(message)
                        session.walk_plan = plan
                        plan.start_batch(session)
                        walk_deadline = plan.deadline
                        walking = True
                    except ValueError as error:
                        emit(source='adapter', error=str(error))
                elif kind == 'center':
                    if walking:
                        emit(source='adapter', error='Stop the walk before centering')
                    else:
                        center_servos(session)
                elif kind == 'stop':
                    session.command('STOP')
                    walking = False
                    if plan: plan.cancelled = True
                    emit(source='device', event='stop-acknowledged', walkProgress=plan.progress() if plan else None)
                elif kind != 'status':
                    emit(source='adapter', error='Unknown control type; use status, center, walk, stop or cancel')
            poll_at = time.monotonic()
            state = session.status()  # SNAPSHOT/legacy STATUS is the command heartbeat.
            if walking and walk_deadline is not None and time.monotonic() >= walk_deadline:
                session.command('STOP')
                raise TimeoutError('Walk duration exceeded; stopped without retry')
            if walking and state.get('running') == 0:
                if plan.finish_batch(state):
                    walking = False
                    emit(source='device', event='walk-completed', walkProgress=plan.progress())
                    if action == 'walk':
                        return
                else:
                    plan.start_batch(session)
            time.sleep(max(0, poll_seconds - (time.monotonic() - poll_at)))
        if not stopping and action == 'walk' and walking:
            raise TimeoutError('Walk duration exceeded; stopping device')
    finally:
        emit(source='device', telemetryStale=True, commandedPulseUs={}, synchronization='unavailable', shaftPosition='unmeasured', walkProgress=session.walk_plan.progress() if session.walk_plan else None)
        session.close()  # STOP uses the sole existing connection, including cancellation.

if __name__ == '__main__':
    try:
        main()
    except InterruptedError:
        pass
    except Exception as error:
        # Never include connection/config exception details or authentication material.
        message = str(error) if isinstance(error, (RuntimeError, TimeoutError)) else type(error).__name__ + ': local device connection failed'
        emit(source='adapter', error=message)
        sys.exit(1)

