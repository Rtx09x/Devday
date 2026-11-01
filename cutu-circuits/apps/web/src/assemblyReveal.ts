export const assemblyStages = [
  { title: "Servo cluster", detail: "Three aligned cases", durationMs: 4000 },
  {
    title: "Horns & pivots",
    detail: "The motion connections",
    durationMs: 3400,
  },
  { title: "Left leg 1", detail: "Front wire leg & foot", durationMs: 3000 },
  { title: "Left leg 2", detail: "Middle wire leg & foot", durationMs: 3000 },
  { title: "Left leg 3", detail: "Rear wire leg & foot", durationMs: 3000 },
  { title: "Right leg 1", detail: "Front wire leg & foot", durationMs: 3000 },
  { title: "Right leg 2", detail: "Middle wire leg & foot", durationMs: 3000 },
  { title: "Right leg 3", detail: "Rear wire leg & foot", durationMs: 3000 },
  { title: "NodeMCU", detail: "Rear-mounted controller", durationMs: 4000 },
  { title: "Wiring", detail: "D5 · D6 · D7 · common ground", durationMs: 4400 },
  { title: "Makada complete", detail: "Ready to explore", durationMs: 3000 },
] as const;

export const controllerStage = 8;
export const wiringStage = 9;
export const completeAssemblyStage = assemblyStages.length - 1;

export function assemblyStageFor(id: string): number {
  if (/^(horn-|glue-)/.test(id)) return 1;
  const leg = /^(?:leg|foot)-(left|right)-([1-3])(?:$|-)/.exec(id);
  if (leg) return 2 + (leg[1] === "right" ? 3 : 0) + Number(leg[2]) - 1;
  if (/^controller(?:$|-)/.test(id) && id !== "controller-common-ground")
    return controllerStage;
  if (/^(cable-|plug-|power-bus|controller-common-ground)/.test(id))
    return wiringStage;
  return 0;
}

export function nextAssemblyStage(stage: number, direction: number): number {
  return Math.min(completeAssemblyStage, Math.max(0, stage + direction));
}

export function revealStep(
  current: number,
  target: number,
  elapsedSeconds: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion || Math.abs(target - current) < 0.002) return target;
  return (
    current +
    (target - current) * (1 - Math.exp(-Math.max(0, elapsedSeconds) * 3.5))
  );
}
