"""Run the MCU gait with a live heartbeat and an explicit bounded cycle count."""
import argparse
import time
from hexapod import Robot

parser = argparse.ArgumentParser()
parser.add_argument('--host', help='Board address; defaults to the locally saved address')
parser.add_argument('--steps', type=int, default=1, choices=range(1, 21))
parser.add_argument('--speed', type=int, default=100, choices=range(1, 101))
args = parser.parse_args()
robot = Robot(args.host)
try:
    robot.command('STOP')
    timing = robot.command('TIMING')
    fields = dict(item.split('=', 1) for item in timing.split()[1:])
    move_ms, settle_ms = int(fields['move_ms']), int(fields['settle_ms'])
    period_ms = move_ms + (100 - args.speed) * (max(move_ms, 8000) - move_ms) // 99
    robot.command('CLEAR')
    robot.command(f'ADD 100 100 {args.steps} {args.speed}')
    for joint in (1, 2, 3):
        robot.command(f'ENABLE {joint}')
        time.sleep(.6)
        robot.command('PING')
    robot.command('RUN')
    # STATUS is also a heartbeat. Motion is timed locally, independently of TCP latency.
    deadline = time.monotonic() + args.steps * 8 * (period_ms + settle_ms) / 1000 + 15
    while time.monotonic() < deadline:
        time.sleep(.5)
        status = robot.command('STATUS')
        if 'running=0 ' in status:
            if f'action=1 ' not in status:
                raise RuntimeError('Motion stopped before completing the queue')
            break
    else:
        raise TimeoutError('MCU gait did not finish within its bounded duration')
finally:
    try:
        robot.command('STOP')
    finally:
        robot.close()
