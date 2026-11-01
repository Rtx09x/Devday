export type SimulationMatrixRunLeaseResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

let active = false;

/**
 * Prevent duplicate matrix execution inside one loaded extension instance.
 * This is deliberately process-local; the public filesystem API still cannot
 * provide cross-process exclusive create, atomic no-clobber, or symlink proof.
 */
export async function withSimulationMatrixRunLease<T>(
  run: () => Promise<T>,
): Promise<SimulationMatrixRunLeaseResult<T>> {
  if (active) return { acquired: false };
  active = true;
  try {
    return { acquired: true, value: await run() };
  } finally {
    active = false;
  }
}
