import { useState } from "react";
import { Button, Input } from "@cutucircuits/ui";
import type { Operation } from "@cutucircuits/core";
import { Glyph } from "./Glyph";
import "./robotWalk.css";

function lastProgress(operation?: Operation): { requestedCycles: number; completedCycles: number } | undefined {
  if (!operation) return;
  const lines = operation.output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"walkProgress"')) continue;
    try {
      const progress = JSON.parse(lines[i]).walkProgress;
      if (progress && typeof progress.requestedCycles === "number" && typeof progress.completedCycles === "number") return progress;
    } catch { /* A bounded output buffer may start or end inside a line. */ }
  }
}

export function RobotWalkControls({ operations, busy, maxCycles = 100, onWalk, onStop, onDetails }: {
  operations: Operation[]; busy: boolean;
  maxCycles?: number;
  onWalk: (cycles: number) => void; onStop: (operation: Operation) => void; onDetails: () => void;
}) {
  const [cycles, setCycles] = useState("5");
  const active = operations.find(o => o.status === "running");
  const last = [...operations].reverse().find(o => o.capabilityId === "walk");
  const progress = lastProgress(last);
  const count = Number(cycles);
  const valid = Number.isInteger(count) && count >= 1 && count <= maxCycles;
  const walking = active?.capabilityId === "walk";
  return <section className="robot-walk" aria-label="Real robot controls">
    <div className="robot-walk-copy">
      <strong>Real robot <span>Wi-Fi</span></strong>
      <small aria-live="polite">{walking
        ? progress ? `${progress.completedCycles} / ${progress.requestedCycles} cycles · walking` : "Connecting to controller…"
        : active?.capabilityId === "connect" ? "Controller session active · movement is manual"
        : last?.status === "failed" ? `Walk stopped${progress ? ` · ${progress.completedCycles} / ${progress.requestedCycles} cycles observed` : ""} · check connection`
        : last?.status === "cancelled" ? `Stopped${progress ? ` · ${progress.completedCycles} / ${progress.requestedCycles} cycles observed` : ""}`
        : last?.status === "succeeded" && progress ? `${progress.completedCycles} cycles complete · outputs detached`
        : `Real motion · clear the path · 1–${maxCycles} cycles`}</small>
    </div>
    <label className="robot-walk-count">Gait cycles
      <Input aria-label="Gait cycles" type="number" min={1} max={maxCycles} step={1}
        value={cycles} disabled={walking || busy} onChange={event => setCycles(event.target.value)} />
    </label>
    <Button variant="filled" aria-label="Walk forward" disabled={!valid || busy || (!!active && active.capabilityId !== "connect")}
      onClick={() => onWalk(count)}><Glyph name="play" />{busy ? "Starting…" : "Walk forward"}</Button>
    {active && <Button className="robot-stop" aria-label="Stop robot" onClick={() => onStop(active)}><Glyph name="stop" />Stop</Button>}
    <Button aria-label="Robot connection and settings" onClick={onDetails}><Glyph name="more" /></Button>
  </section>;
}
