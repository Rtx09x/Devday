export type ElectricalValueUnit = 'resistance' | 'capacitance' | 'inductance';

type EngineeringScale = {
  factor: number;
  suffix: string;
};

const SCALES: Record<ElectricalValueUnit, EngineeringScale[]> = {
  resistance: [
    { factor: 1e9, suffix: 'G' },
    { factor: 1e6, suffix: 'M' },
    { factor: 1e3, suffix: 'k' },
    { factor: 1, suffix: '' },
  ],
  capacitance: [
    { factor: 1, suffix: 'F' },
    { factor: 1e-3, suffix: 'mF' },
    { factor: 1e-6, suffix: 'uF' },
    { factor: 1e-9, suffix: 'nF' },
    { factor: 1e-12, suffix: 'pF' },
  ],
  inductance: [
    { factor: 1, suffix: 'H' },
    { factor: 1e-3, suffix: 'mH' },
    { factor: 1e-6, suffix: 'uH' },
    { factor: 1e-9, suffix: 'nH' },
    { factor: 1e-12, suffix: 'pH' },
  ],
};

function roundToThreeSignificantDigits(value: number): number {
  if (value === 0) return 0;
  return Number(value.toPrecision(3));
}

/** Format a numeric SI value for compact UI display without rewriting source literals. */
export function formatElectricalValue(value: string | number, unit?: ElectricalValueUnit): string {
  if (typeof value !== 'number' || !unit || !Number.isFinite(value)) return String(value);

  const scales = SCALES[unit];
  const magnitude = Math.abs(value);
  let scaleIndex = scales.findIndex((scale) => magnitude >= scale.factor);
  if (scaleIndex < 0) scaleIndex = scales.length - 1;

  let rounded = roundToThreeSignificantDigits(value / scales[scaleIndex].factor);
  if (Math.abs(rounded) >= 1000 && scaleIndex > 0) {
    scaleIndex -= 1;
    rounded = roundToThreeSignificantDigits(value / scales[scaleIndex].factor);
  }

  return `${Object.is(rounded, -0) ? 0 : rounded}${scales[scaleIndex].suffix}`;
}
