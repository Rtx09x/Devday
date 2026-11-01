import { useEffect, useRef } from "react";
import { Button } from "@cutucircuits/ui";
import { assemblyStages, completeAssemblyStage } from "./assemblyReveal";
import "./assemblyReplay.css";

interface Props {
  stage: number | null;
  run: number;
  onStage: (stage: number | null) => void;
}

/** A tool-triggered presentation of existing meshes, independent of device motion. */
export function AssemblyReplay({ stage, run, onStage }: Props) {
  const callback = useRef(onStage);
  callback.current = onStage;
  useEffect(() => {
    if (stage === null) return;
    let remaining: number = assemblyStages[stage].durationMs;
    let started = 0;
    let renderingPaused = false;
    let timer: number | undefined;
    const pause = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (performance.now() - started));
    };
    const resume = () => {
      if (document.hidden || renderingPaused || timer !== undefined) return;
      started = performance.now();
      timer = window.setTimeout(() => {
        timer = undefined;
        callback.current(stage === completeAssemblyStage ? null : stage + 1);
      }, remaining);
    };
    const visibility = () => (document.hidden ? pause() : resume());
    const rendering = (event: Event) => {
      renderingPaused = Boolean((event as CustomEvent<boolean>).detail);
      if (renderingPaused) pause();
      else resume();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("cutu:build-rendering-paused", rendering);
    resume();
    return () => {
      pause();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("cutu:build-rendering-paused", rendering);
    };
  }, [stage, run]);

  if (stage === null) return null;
  const current = assemblyStages[stage];
  return (
    <section
      className="assembly-replay"
      aria-label="Building Makada"
      data-stage={stage}
    >
      <div className="replay-description" aria-live="polite" aria-atomic="true">
        <span>
          {String(stage + 1).padStart(2, "0")} / {assemblyStages.length}
        </span>
        <strong>{current.title}</strong>
        <small>{current.detail}</small>
      </div>
      <div className="replay-progress" aria-hidden="true">
        {assemblyStages.map((_, index) => (
          <i key={index} data-revealed={index <= stage} />
        ))}
      </div>
      <Button className="replay-stop" onClick={() => onStage(null)}>
        Stop building
      </Button>
    </section>
  );
}
