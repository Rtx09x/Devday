import type { PeripheralEvent, SimResult } from './types.ts';
import { measureDigitalTrace } from './digitalTrace.ts';

type AdcSampleEvent = Extract<PeripheralEvent, { kind: 'adc-sample' }>;

export const AVR_ADC_PWM_CLOCK_HZ = 16_000_000;
export const AVR_ADC_PWM_PERIOD_CYCLES = 16_384;
export const AVR_ADC_PWM_FREQUENCY_HZ = AVR_ADC_PWM_CLOCK_HZ / AVR_ADC_PWM_PERIOD_CYCLES;
export const AVR_ADC_PWM_MIN_COMPARE = 16;
export const AVR_ADC_PWM_MAX_COMPARE = 240;

export interface AdcPwmControllerIntentEvidence {
  inputVoltage: number;
  raw: number;
  conversionStartCycle: number;
  conversionCompleteCycle: number;
  compareValue: number;
  frequencyHz: number;
  dutyCycle: number;
  highCycles: number;
  periodCycles: number;
  completePeriods: number;
  clockHz: number;
}

export function adcPwmCompareForRaw(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw < 0 || raw > 1023) throw new Error('ADC→PWM evidence requires one exact 10-bit raw code.');
  return Math.min(AVR_ADC_PWM_MAX_COMPARE, Math.max(AVR_ADC_PWM_MIN_COMPARE, raw >> 2));
}

function exactSample(result: SimResult): AdcSampleEvent | undefined {
  if ((result.peripheralEventsOmitted ?? 0) !== 0) return undefined;
  const samples = (result.peripheralEvents ?? []).filter((event): event is AdcSampleEvent => event.kind === 'adc-sample');
  return samples.length === 1 ? samples[0] : undefined;
}

export function deriveAdcPwmControllerIntentEvidence(result: SimResult): AdcPwmControllerIntentEvidence | undefined {
  if (!result.ok || result.engine !== 'avr8js' || result.mode !== 'mcu'
    || result.firmwareFixture?.id !== 'avr-adc-pwm-controller-intent') return undefined;
  const voltage = result.modeledStimulus?.adc0_voltage;
  if (typeof voltage !== 'number' || !Number.isFinite(voltage) || voltage < 0 || voltage > 5) return undefined;
  const sample = exactSample(result);
  if (!sample || sample.controller !== 'ADC0' || sample.channel !== 'ADC0' || sample.pinAlias !== 'A0'
    || sample.inputVoltage !== voltage || sample.reference !== 'AVCC' || sample.referenceVoltage !== 5
    || sample.resolutionBits !== 10 || !Number.isSafeInteger(sample.startCycle)
    || !Number.isSafeInteger(sample.completeCycle) || sample.completeCycle <= sample.startCycle) return undefined;
  const expectedRaw = Math.min(Math.max(Math.floor((voltage / 5) * 1024), 0), 1023);
  if (sample.raw !== expectedRaw) return undefined;
  const traces = result.traces.filter((trace) => trace.name === 'D6'
    && trace.origin?.family === 'avr' && trace.origin.port === 'D' && trace.origin.bit === 6);
  if (traces.length !== 1) return undefined;
  const measurement = measureDigitalTrace(traces[0]);
  const compareValue = adcPwmCompareForRaw(sample.raw);
  const expectedDuty = compareValue / 256;
  if (!measurement || measurement.timingDomain !== 'emulator-cycles'
    || measurement.clockHz !== AVR_ADC_PWM_CLOCK_HZ
    || measurement.averagePeriod !== AVR_ADC_PWM_PERIOD_CYCLES
    || measurement.frequencyHz !== AVR_ADC_PWM_FREQUENCY_HZ
    || measurement.averageHigh !== compareValue * 64
    || measurement.dutyCycle !== expectedDuty
    || measurement.completePeriods < 2) return undefined;
  return {
    inputVoltage: voltage,
    raw: sample.raw,
    conversionStartCycle: sample.startCycle,
    conversionCompleteCycle: sample.completeCycle,
    compareValue,
    frequencyHz: measurement.frequencyHz,
    dutyCycle: measurement.dutyCycle,
    highCycles: measurement.averageHigh,
    periodCycles: measurement.averagePeriod,
    completePeriods: measurement.completePeriods,
    clockHz: measurement.clockHz,
  };
}
