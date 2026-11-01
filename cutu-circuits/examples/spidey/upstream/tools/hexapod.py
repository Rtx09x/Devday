"""Send explicit commands or bounded action sequences to the robot."""
import argparse
import json
import socket
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / '.local/wifi.json'
PRESETS = {'forward': (100, 100), 'backward': (-100, -100),
           'left': (-100, 100), 'right': (100, -100),
           'curve-left': (40, 100), 'curve-right': (100, 40)}

class Robot:
    def __init__(self, host=None):
        if not CONFIG.exists():
            raise RuntimeError('No local credentials. Run python tools/setup_robot.py init first, or privately copy .local/wifi.json from the previous PC.')
        config = json.loads(CONFIG.read_text(encoding='utf-8-sig'))
        address = host or config.get('host')
        if not address:
            raise RuntimeError('No board address saved. Run python tools/setup_robot.py discover --host BOARD_IP, or discover --port COMx with servo power disconnected.')
        self.socket = socket.create_connection((address, 8266), timeout=3)
        self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.reader = self.socket.makefile('rb')
        self.command('AUTH ' + config['token'])

    def command(self, command):
        self.socket.sendall((command + '\n').encode('ascii'))
        reply = self.reader.readline().decode('ascii').strip()
        # Autonomous completion may arrive before the reply to this command.
        while reply == 'DONE':
            print(reply)
            reply = self.reader.readline().decode('ascii').strip()
        if not reply:
            raise ConnectionError('Robot disconnected')
        print(reply)
        if reply.startswith('ERR'):
            raise RuntimeError(reply)
        return reply

    def close(self):
        self.reader.close()
        self.socket.close()

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', help='NodeMCU address (default: saved address)')
    sub = p.add_subparsers(dest='action', required=True)
    for name in ('status', 'stop', 'clear', 'run', 'config', 'diag'):
        sub.add_parser(name)
    timing = sub.add_parser('timing')
    timing.add_argument('move_ms', type=int, nargs='?')
    timing.add_argument('settle_ms', type=int, nargs='?')
    enable = sub.add_parser('enable')
    enable.add_argument('joint', choices=['1', '2', '3', 'all'])
    disable = sub.add_parser('disable')
    disable.add_argument('joint', type=int, choices=[1, 2, 3])
    jog = sub.add_parser('jog')
    jog.add_argument('joint', type=int, choices=[1, 2, 3])
    jog.add_argument('offset', type=int, help='offset from center in microseconds, within saved limits')
    limits = sub.add_parser('limits')
    limits.add_argument('joint', type=int, choices=[1, 2, 3])
    limits.add_argument('minimum', type=int, help='minimum pulse in microseconds')
    limits.add_argument('maximum', type=int, help='maximum pulse in microseconds')
    trim = sub.add_parser('trim')
    trim.add_argument('joint', type=int, choices=[1, 2, 3])
    trim.add_argument('center', type=int, help='new center pulse in microseconds')
    cal = sub.add_parser('cal')
    cal.add_argument('joint', type=int, choices=[1, 2, 3])
    cal.add_argument('center', type=int)
    cal.add_argument('sign', type=int, choices=[-1, 1])
    cal.add_argument('amplitude', type=int)
    add = sub.add_parser('add')
    add.add_argument('direction', choices=PRESETS)
    add.add_argument('steps', type=int)
    add.add_argument('--speed', type=int, default=20)
    custom = sub.add_parser('custom')
    custom.add_argument('left', type=int)
    custom.add_argument('right', type=int)
    custom.add_argument('steps', type=int)
    custom.add_argument('--speed', type=int, default=20)
    args = p.parse_args()
    if args.action == 'timing' and (args.move_ms is None) != (args.settle_ms is None):
        p.error('timing requires both move_ms and settle_ms, or neither to read settings')
    robot = Robot(args.host)
    try:
        if args.action == 'timing':
            robot.command('TIMING' if args.move_ms is None else f'TIMING {args.move_ms} {args.settle_ms}')
        elif args.action == 'jog':
            robot.command(f'JOG {args.joint} {args.offset}')
        elif args.action == 'cal':
            robot.command(f'CAL {args.joint} {args.center} {args.sign} {args.amplitude}')
        elif args.action == 'limits':
            robot.command(f'LIMIT {args.joint} {args.minimum} {args.maximum}')
        elif args.action == 'trim':
            robot.command(f'TRIM {args.joint} {args.center}')
        elif args.action == 'enable':
            robot.command(f'ENABLE {args.joint.upper()}')
        elif args.action == 'disable':
            robot.command(f'DISABLE {args.joint}')
        elif args.action == 'config':
            robot.socket.sendall(b'CONFIG\n')
            while True:
                reply = robot.reader.readline().decode('ascii').strip()
                if not reply:
                    raise ConnectionError('Robot disconnected')
                print(reply)
                if reply == 'OK CONFIG':
                    break
        elif args.action in ('add', 'custom'):
            left, right = PRESETS[args.direction] if args.action == 'add' else (args.left, args.right)
            robot.command(f'ADD {left} {right} {args.steps} {args.speed}')
        else:
            robot.command(args.action.upper())
    finally:
        robot.close()

if __name__ == '__main__':
    main()
