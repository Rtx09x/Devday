import { fixturesForMcu } from './firmwareFixtures.ts';
import type { FirmwareFixtureId, McuTarget } from './types.ts';
import type { AnyCircuitElement } from '../circuit/circuitJson.ts';

export interface FirmwareFixtureOption {
  id: FirmwareFixtureId;
  label: string;
  description: string;
}

export function firmwareFixtureOptions(mcu: McuTarget): FirmwareFixtureOption[] {
  return fixturesForMcu(mcu).map(({ id, label, description }) => ({ id, label, description }));
}

export function preferredFirmwareFixture(mcu: McuTarget, circuitJson: readonly AnyCircuitElement[] = []): FirmwareFixtureId | undefined {
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_TIMER2_TONE_EMU')) {
    return 'avr-timer2-tone-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_SERVO_EMU')) {
    return 'avr-servo-pulse-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_SPI_EMU')) {
    return 'avr-spi-pixel-palette';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_ADC_EMU')) {
    return 'avr-adc-threshold';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_ADC_PWM_EMU')) {
    return 'avr-adc-pwm-controller-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_I2C_EMU')) {
    return 'avr-i2c-display-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_UART_EMU')) {
    return 'avr-uart-command-response';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_STEP_DIR_EMU')) {
    return 'avr-step-dir-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_LIMIT_INTERLOCK_EMU')) {
    return 'avr-limit-interlock-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_QUADRATURE_EMU')) {
    return 'avr-quadrature-detent-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_BUTTON_DEBOUNCE_EMU')) {
    return 'avr-button-debounce-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_NEOPIXEL_EMU')) {
    return 'avr-neopixel-frame-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_EEPROM_EMU')) {
    return 'avr-eeprom-roundtrip-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_WATCHDOG_EMU')) {
    return 'avr-watchdog-reset-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_INT0_EMU')) {
    return 'avr-int0-interrupt-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_PULSE_COUNTER_EMU')) {
    return 'avr-timer1-pulse-counter-intent';
  }
  if (mcu === 'avr' && circuitJson.some((element) => element.type === 'source_component' && element.name === 'ATMEGA328P_PCINT_MASK_EMU')) {
    return 'avr-pcint-mask-intent';
  }
  return fixturesForMcu(mcu)[0]?.id;
}
