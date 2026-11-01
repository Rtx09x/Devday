import type { PcbScalarMinimums } from './projectGuidance.ts';

export const REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID =
  'jlcpcb-fr4-2layer-1oz-routed-reviewed-2026-07-13' as const;

export type ReviewedFabProfileId = typeof REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID;

export interface ReviewedFabProfileAssumptions {
  material: 'FR4';
  layerCount: 2;
  outerCopperOz: 1;
  outlineProcess: 'routed';
}

export interface ReviewedFabProfile {
  id: ReviewedFabProfileId;
  label: string;
  reviewedAt: '2026-07-13';
  sourceUrl: 'https://jlcpcb.com/capabilities/Capabilities';
  assumptions: ReviewedFabProfileAssumptions;
  minimums: PcbScalarMinimums;
  omittedComparisons: string[];
  limitation: string;
}

const ASSUMPTIONS: ReviewedFabProfileAssumptions = {
  material: 'FR4',
  layerCount: 2,
  outerCopperOz: 1,
  outlineProcess: 'routed',
};

const PROFILE: ReviewedFabProfile = {
  id: REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID,
  label: 'JLCPCB FR-4 2-layer 1 oz routed capability reference (reviewed 2026-07-13)',
  reviewedAt: '2026-07-13',
  sourceUrl: 'https://jlcpcb.com/capabilities/Capabilities',
  assumptions: ASSUMPTIONS,
  minimums: {
    minTraceWidthMm: 0.1,
    minViaHoleDiameterMm: 0.15,
    minViaPadDiameterMm: 0.25,
    minBoardEdgeClearanceMm: 0.2,
  },
  omittedComparisons: [
    '0.10 mm trace spacing is omitted because PCB Rule Lens does not inspect trace-to-trace spacing.',
    '0.15 mm different-net SMD-pad spacing is omitted because evaluated pad-to-net identity is not proven by this lens.',
    'Annular rings, pad-to-trace, hole-to-trace, mask, silkscreen, tolerances, stack-up, and every unlisted capability remain unchecked.',
  ],
  limitation: 'This is a dated local transcription of a bounded public capability table under explicit request assumptions, not a live quote, order configuration, DRC/DFM result, vendor acceptance, fabrication signoff, or guarantee.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseReviewedFabProfileAssumptions(value: unknown): ReviewedFabProfileAssumptions {
  if (!isRecord(value)) {
    throw new Error('profile_assumptions must explicitly confirm material, layer_count, outer_copper_oz, and outline_process.');
  }
  const allowed = new Set(['material', 'layer_count', 'outer_copper_oz', 'outline_process']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`profile_assumptions has unsupported field(s): ${unknown.sort().join(', ')}.`);
  if (value.material !== 'FR4' || value.layer_count !== 2 || value.outer_copper_oz !== 1 || value.outline_process !== 'routed') {
    throw new Error('The reviewed profile requires exact assumptions material=FR4, layer_count=2, outer_copper_oz=1, and outline_process=routed.');
  }
  return { ...ASSUMPTIONS };
}

export function getReviewedFabProfile(
  id: unknown,
  assumptions: ReviewedFabProfileAssumptions,
): ReviewedFabProfile {
  if (id !== REVIEWED_JLCPCB_2L_1OZ_PROFILE_ID) throw new Error('Unsupported reviewed fabrication profile.');
  if (assumptions.material !== ASSUMPTIONS.material
    || assumptions.layerCount !== ASSUMPTIONS.layerCount
    || assumptions.outerCopperOz !== ASSUMPTIONS.outerCopperOz
    || assumptions.outlineProcess !== ASSUMPTIONS.outlineProcess) {
    throw new Error('Reviewed fabrication profile assumptions do not match the exact registered profile.');
  }
  return {
    ...PROFILE,
    assumptions: { ...PROFILE.assumptions },
    minimums: { ...PROFILE.minimums },
    omittedComparisons: [...PROFILE.omittedComparisons],
  };
}
