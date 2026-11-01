import { Button, IconButton } from "@cutucircuits/ui";
import type { MotionDefinition } from "@cutucircuits/core";
import type { ProgramMotion } from "./programMotion";
import { Glyph } from "./Glyph";
export function MotionStrip({
  motion,
  playing,
  phase,
  setPlaying,
  setPhase,
  program,
  canFollowProgram,
  onFollowProgram,
  onReset,
  telemetryStatus,
}: {
  motion: MotionDefinition;
  playing: boolean;
  phase: number;
  program?: ProgramMotion;
  canFollowProgram: boolean;
  onFollowProgram: () => void;
  onReset: () => void;
  telemetryStatus?: string;
  setPlaying: (playing: boolean) => void;
  setPhase: (phase: number) => void;
}) {
  return (
    <div className="motion-strip">
      <IconButton
        label={playing ? "Pause motion preview" : "Play motion preview"}
        variant="filled"
        onClick={() => setPlaying(!playing)}
      >
        <Glyph name={playing ? "stop" : "play"} />
      </IconButton>
      {motion.previewTravel && (
        <IconButton label="Reset walking preview" onClick={onReset}>
          <Glyph name="reset" />
        </IconButton>
      )}
      <div className="motion-label">
        <strong>{program ? "Program commanded motion" : motion.name}</strong>
        <span>
          {telemetryStatus ??
            (program
              ? `Program: ${program.source} · illustrative`
              : `Commanded ${motion.previewTravel ? "walking " : ""}preview · ${motion.calibrated ? "project calibrated" : "uncalibrated"}`) +
              " · no measured feedback"}
        </span>
      </div>
      {canFollowProgram && (
        <Button className="control-button" onClick={onFollowProgram}>
          Follow program
        </Button>
      )}
      <details className="motion-phases">
        <summary>
          Phases <Glyph name="down" />
        </summary>
        <div className="phase-buttons">
          {motion.phases.map((p, i) => (
            <button
              aria-label={`Preview phase ${i + 1}: ${p.label}`}
              className={!program && !playing && phase === i ? "active" : ""}
              key={i}
              onClick={() => {
                setPlaying(false);
                setPhase(i);
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </details>
      <span className="motion-time">
        {(
          motion.phases.reduce((s, p) => s + p.durationMs + p.settleMs, 0) /
          1000
        ).toFixed(1)}{" "}
        s
      </span>
    </div>
  );
}
