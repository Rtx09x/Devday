"""Editable project program. Offline inspection or real serial JSONL acquisition.
A real board must emit newline-delimited JSON objects. Requires pyserial for serial.
"""
import json
import signal
import sys
import threading
import time
from pathlib import Path

stopping = False

def stop(*_):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
inputs = json.loads(sys.stdin.readline() or '{}')
def controls():
    for line in sys.stdin:
        try:
            if json.loads(line).get('type') == 'cancel':
                stop()
        except (ValueError, AttributeError):
            pass

threading.Thread(target=controls, daemon=True).start()
action = sys.argv[1]
if action == 'inspect':
    project = json.loads(Path('cutucircuits.project.json').read_text())
    print(json.dumps({'source': 'project-files', 'entities': len(project['entities']), 'controller': 'Generic 3.3 V microcontroller', 'sensor': 'Photoresistor divider on A0', 'led': 'D2 through 330 ohm resistor', 'connected': False}), flush=True)
elif action == 'serial':
    try:
        import serial
    except ImportError:
        raise SystemExit('Install pyserial locally to use the real serial capability: python3 -m pip install pyserial')
    with serial.Serial(inputs['port'], inputs['baud'], timeout=.2) as board:
        deadline = time.monotonic() + inputs['durationSeconds']
        while not stopping and time.monotonic() < deadline:
            line = board.readline(8193)
            if len(line) > 8192:
                raise RuntimeError('Serial record exceeds limit')
            if line:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError('Board must emit JSON objects')
                print(json.dumps({'source': 'serial-device', 'record': record}), flush=True)
else:
    raise SystemExit('Unknown action')
