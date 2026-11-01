import {
  RP2040_LAUNCH_BEACON_BYTES,
  RP2040_LAUNCH_BEACON_SHA256,
} from './generated/rp2040LaunchBeacon.ts';
import {
  AVR_PWM_HEARTBEAT_BYTES,
  AVR_PWM_HEARTBEAT_SHA256,
} from './generated/avrPwmHeartbeat.ts';
import {
  AVR_SERVO_PULSE_INTENT_BYTES,
  AVR_SERVO_PULSE_INTENT_SHA256,
} from './generated/avrServoPulseIntent.ts';
import {
  AVR_TIMER2_TONE_INTENT_BYTES,
  AVR_TIMER2_TONE_INTENT_SHA256,
} from './generated/avrTimer2ToneIntent.ts';
import {
  AVR_SPI_PIXEL_PALETTE_BYTES,
  AVR_SPI_PIXEL_PALETTE_SHA256,
} from './generated/avrSpiPixelPalette.ts';
import {
  AVR_ADC_THRESHOLD_BYTES,
  AVR_ADC_THRESHOLD_SHA256,
} from './generated/avrAdcThreshold.ts';
import {
  AVR_ADC_PWM_CONTROLLER_INTENT_BYTES,
  AVR_ADC_PWM_CONTROLLER_INTENT_SHA256,
} from './generated/avrAdcPwmControllerIntent.ts';
import {
  AVR_I2C_DISPLAY_INTENT_BYTES,
  AVR_I2C_DISPLAY_INTENT_SHA256,
} from './generated/avrI2cDisplayIntent.ts';
import {
  AVR_UART_COMMAND_RESPONSE_BYTES,
  AVR_UART_COMMAND_RESPONSE_SHA256,
} from './generated/avrUartCommandResponse.ts';
import {
  AVR_STEP_DIR_INTENT_BYTES,
  AVR_STEP_DIR_INTENT_SHA256,
} from './generated/avrStepDirIntent.ts';
import {
  AVR_LIMIT_SWITCH_INTERLOCK_BYTES,
  AVR_LIMIT_SWITCH_INTERLOCK_SHA256,
} from './generated/avrLimitSwitchInterlock.ts';
import {
  AVR_QUADRATURE_DETENT_BYTES,
  AVR_QUADRATURE_DETENT_SHA256,
} from './generated/avrQuadratureDetent.ts';
import {
  AVR_BUTTON_DEBOUNCE_BYTES,
  AVR_BUTTON_DEBOUNCE_SHA256,
} from './generated/avrButtonDebounce.ts';
import {
  AVR_NEOPIXEL_FRAME_BYTES,
  AVR_NEOPIXEL_FRAME_SHA256,
} from './generated/avrNeopixelFrame.ts';
import {
  AVR_EEPROM_ROUNDTRIP_INTENT_BYTES,
  AVR_EEPROM_ROUNDTRIP_INTENT_SHA256,
} from './generated/avrEepromRoundtripIntent.ts';
import {
  AVR_WATCHDOG_RESET_INTENT_BYTES,
  AVR_WATCHDOG_RESET_INTENT_SHA256,
} from './generated/avrWatchdogResetIntent.ts';
import {
  AVR_INT0_INTERRUPT_INTENT_BYTES,
  AVR_INT0_INTERRUPT_INTENT_SHA256,
} from './generated/avrInt0InterruptIntent.ts';
import {
  AVR_TIMER1_PULSE_COUNTER_INTENT_BYTES,
  AVR_TIMER1_PULSE_COUNTER_INTENT_SHA256,
} from './generated/avrTimer1PulseCounterIntent.ts';
import {
  AVR_PCINT_MASK_INTENT_BYTES,
  AVR_PCINT_MASK_INTENT_SHA256,
} from './generated/avrPcintMaskIntent.ts';
import type { FirmwareFixtureId, McuTarget } from './types.ts';

export interface FirmwareFixture {
  id: FirmwareFixtureId;
  label: string;
  mcu: McuTarget;
  imageFormat: 'rp2040-raw-binary' | 'avr-word-little-endian';
  bytes: Uint8Array;
  sha256: string;
  sourcePath: string;
  defaultDurationMs: number;
  description: string;
  limitations: string[];
}

export const FIRMWARE_FIXTURES: readonly FirmwareFixture[] = [
  {
    id: 'rp2040-launch-beacon',
    label: 'RP2040 Launch Beacon',
    mcu: 'rp2040',
    imageFormat: 'rp2040-raw-binary',
    bytes: RP2040_LAUNCH_BEACON_BYTES,
    sha256: RP2040_LAUNCH_BEACON_SHA256,
    sourcePath: 'examples/firmware/rp2040-launch-beacon.S',
    defaultDurationMs: 8,
    description: 'Raw vector-table Thumb fixture: UART READY/LIFTOFF plus three GP25 pulses.',
    limitations: [
      'Boots directly from the flash vector table without an RP2040 boot ROM.',
      'The checked-in Thumb source assembles byte-for-byte to the embedded 141-byte image and recorded SHA-256 through the strict in-repo Node fixture assembler; no external compiler, network, or download is used.',
      'The in-repo assembler intentionally supports only this fixture\'s bounded Cortex-M0+ syntax and fails closed on unknown directives, instructions, labels, alignment, or ranges; it is not a general ARM toolchain.',
      'The openable example uses synthetic pinrow2 only as a doNotPlace evaluator/drawing aid with PCB disabled; it is not a placeable or official RP2040 package footprint, manufacturer-part declaration, or package-pin mapping.',
      'Proves only rp2040js UART0 and GP25 output behavior; it does not model a physical Pico, attached LED, PCB copper, or timing fidelity.',
    ],
  },
  {
    id: 'avr-pwm-heartbeat',
    label: 'AVR PWM Heartbeat',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_PWM_HEARTBEAT_BYTES,
    sha256: AVR_PWM_HEARTBEAT_SHA256,
    sourcePath: 'examples/firmware/avr-pwm-heartbeat.asm',
    defaultDurationMs: 20,
    description: 'ATmega328P timer0 fast-PWM fixture: OC0A / Arduino D6 near 976.56 Hz and nominal 25% duty.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The checked-in source assembles byte-for-byte to the embedded 24-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of hardware timing.',
      'The openable example uses synthetic pinrow2 only as a doNotPlace evaluator/drawing aid with PCB disabled; it is not an ATmega328P/Uno footprint, manufacturer-part declaration, or package-pin mapping.',
      'Proves only avr8js timer0 and D6 GPIO observation at its modeled 16 MHz clock; it does not model calibrated hardware timing, a physical Uno, attached LED/load/current, or PCB copper.',
    ],
  },
  {
    id: 'avr-servo-pulse-intent',
    label: 'AVR Timer1 Servo Pulse Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_SERVO_PULSE_INTENT_BYTES,
    sha256: AVR_SERVO_PULSE_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-servo-pulse-intent.asm',
    defaultDurationMs: 70,
    description: 'ATmega328P Timer1 Fast PWM intent: OC1A / Arduino D9 at exact modeled 50 Hz with a 1500 us high pulse.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The checked-in assembly writes each 16-bit Timer1 high byte before its low byte; the generated bytes and digest are deterministic provenance, not proof of hardware timing.',
      'The openable example uses synthetic pinrow2 components only as doNotPlace evaluator/drawing aids with PCB disabled; they are not official packages, footprints, manufacturer-part declarations, or package-pin mappings.',
      'Proves only avr8js Timer1/OC1A D9 controller-output intent at its modeled 16 MHz clock. It does not model a physical servo, angle/position, load/current, calibrated timing, electrical waveform/signal integrity, PCB copper, or hardware.',
    ],
  },
  {
    id: 'avr-timer2-tone-intent',
    label: 'AVR Timer2 Tone Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_TIMER2_TONE_INTENT_BYTES,
    sha256: AVR_TIMER2_TONE_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-timer2-tone-intent.asm',
    defaultDurationMs: 8,
    description: 'ATmega328P Timer2 CTC intent: OC2B / Arduino D3 at exact modeled 1 kHz with 50% duty.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The generated bytes and SHA-256 are deterministic source/image provenance for this fixture; they are not proof of hardware timing or electrical behavior.',
      'The openable example uses synthetic pinrow2 components only as doNotPlace evaluator/drawing aids with PCB disabled; they are not official packages, footprints, manufacturer-part declarations, or package-pin mappings.',
      'Proves only avr8js Timer2/OC2B D3 controller-output intent at its modeled 16 MHz clock. It does not model a buzzer, speaker, emitted sound, loudness, load/current, calibrated timing, electrical waveform/signal integrity, PCB copper, or hardware.',
    ],
  },
  {
    id: 'avr-spi-pixel-palette',
    label: 'AVR SPI Pixel Palette',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_SPI_PIXEL_PALETTE_BYTES,
    sha256: AVR_SPI_PIXEL_PALETTE_SHA256,
    sourcePath: 'examples/firmware/avr-spi-pixel-palette.asm',
    defaultDurationMs: 2,
    description: 'SPI0 output-only APA102-style frame intent: red, green, and blue bytes with exact controller configuration.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The checked-in expanded assembly assembles byte-for-byte to the embedded 304-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of external-peripheral or hardware behavior.',
      'SPI evidence is byte-level at avr8js controller callbacks. MOSI/SCK waveforms, signal integrity, and calibrated physical timing are not modeled.',
      'The deterministic 0xff RX byte is an idle emulator response used only to complete each transfer; it is not evidence from an APA102 or any external device.',
      'The openable example is schematic-only and synthetic. Transmitted color intent does not prove an attached pixel, emitted light, voltage/current, PCB copper, or a physical Uno.',
    ],
  },
  {
    id: 'avr-adc-threshold',
    label: 'AVR ADC Threshold',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_ADC_THRESHOLD_BYTES,
    sha256: AVR_ADC_THRESHOLD_SHA256,
    sourcePath: 'examples/firmware/avr-adc-threshold.asm',
    defaultDurationMs: 1,
    description: 'One modeled ADC0 conversion against AVCC 5V; D6 goes high at raw code 512 or above.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The checked-in assembly assembles byte-for-byte to the embedded 48-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of sensor, analog-front-end, or hardware behavior.',
      'ADC0 voltage is an explicit bounded avr8js stimulus. It does not come from the schematic, an attached sensor, a SPICE analog front end, or physical hardware.',
      'The openable example is schematic-only and synthetic. It does not prove source impedance, loading, noise, calibration, voltage/current behavior, external LED behavior, package pins, PCB copper, or physical ADC accuracy.',
    ],
  },
  {
    id: 'avr-adc-pwm-controller-intent',
    label: 'AVR ADC→PWM Controller Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_ADC_PWM_CONTROLLER_INTENT_BYTES,
    sha256: AVR_ADC_PWM_CONTROLLER_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-adc-pwm-controller-intent.asm',
    defaultDurationMs: 20,
    description: 'One explicit ADC0 sample maps through firmware to clamped Timer0 OC0A/D6 duty at exact modeled 976.5625 Hz.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The checked-in source assembles byte-for-byte to the exact embedded 70-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of sensor, load, or hardware behavior.',
      'ADC0 voltage is an explicit bounded avr8js stimulus. Firmware left-adjusts the sample, uses raw bits 9..2 as OCR0A, and clamps the compare value to 16..240 for modeled 6.25%..93.75% duty.',
      'The openable example is schematic-only and synthetic. It does not model a sensor, analog front end, fan, motor, driver, load/current, speed/torque/airflow, electrical waveform, calibrated timing, PCB copper, or physical hardware.',
    ],
  },
  {
    id: 'avr-i2c-display-intent',
    label: 'AVR I2C Display Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_I2C_DISPLAY_INTENT_BYTES,
    sha256: AVR_I2C_DISPLAY_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-i2c-display-intent.asm',
    defaultDurationMs: 1,
    description: 'One STOP-bounded TWI0 write intent to 0x3c with bytes 00 ae a6 af; fixture-scoped synthetic ACKs advance avr8js.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, download, or application firmware.',
      'The checked-in assembly assembles byte-for-byte to the embedded 54-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of an external device, bus, display, or hardware behavior.',
      'Exactly five synthetic ACKs are enabled only for this bundled fixture to advance avr8js through address plus four writes. Arbitrary AVR firmware retains default Noop/NACK behavior.',
      'The event is controller write intent captured only at STOP. It is not an external ACK/response, read result, SCL timing/frequency, SDA/SCL waveform, pull-up, arbitration, pin/net, physical display, PCB, or hardware claim.',
      'The openable example is schematic-only and synthetic; pinrow3 is only a doNotPlace drawing aid, not an official footprint or package-pin mapping.',
    ],
  },
  {
    id: 'avr-uart-command-response',
    label: 'AVR UART Command Response',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_UART_COMMAND_RESPONSE_BYTES,
    sha256: AVR_UART_COMMAND_RESPONSE_SHA256,
    sourcePath: 'examples/firmware/avr-uart-command-response.asm',
    defaultDurationMs: 3,
    description: 'One explicit USART0 RX byte drives a polling command response: 1/0 returns K and controls D6; other bytes return ?.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, download, or application firmware.',
      'The checked-in assembly assembles byte-for-byte to the embedded 88-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of an external UART device, wire, or hardware behavior.',
      'Exactly one explicit byte is scheduled only for this bundled fixture through AVRUSART.writeByte(value, false). Arbitrary AVR firmware receives no injected UART data.',
      'RX/TX events are avr8js controller evidence in emulator cycles. They do not prove an external ACK/device, voltage levels, wire waveform, calibrated baud timing, framing/noise/overrun behavior, cable, USB serial, or host response.',
      'The openable example is schematic-only and synthetic; it is not an official ATmega328P/Arduino footprint or package-pin mapping and proves no attached load, PCB copper, or hardware behavior.',
    ],
  },
  {
    id: 'avr-step-dir-intent',
    label: 'AVR Step/Dir Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_STEP_DIR_INTENT_BYTES,
    sha256: AVR_STEP_DIR_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-step-dir-intent.asm',
    defaultDurationMs: 3,
    description: 'Three finite D2 STEP pulses with D3 DIR high and active-low D4 ENABLE low, captured at exact avr8js modeled cycles.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, download, acceleration profile, or application firmware.',
      'The checked-in assembly assembles byte-for-byte to the embedded 28-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of a driver, motor, motion, or hardware behavior.',
      'Pulse edges and levels are avr8js GPIO evidence at a modeled 16 MHz clock. They are not calibrated physical timing, frequency, waveform, voltage, current, or signal-integrity evidence.',
      'The openable example is schematic-only and synthetic. It does not simulate or prove a motor driver, coils/current regulation, microstepping, motion, direction of travel, torque, acceleration, mechanics, PCB copper, or hardware.',
    ],
  },
  {
    id: 'avr-limit-interlock-intent',
    label: 'AVR Limit Interlock Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_LIMIT_SWITCH_INTERLOCK_BYTES,
    sha256: AVR_LIMIT_SWITCH_INTERLOCK_SHA256,
    sourcePath: 'examples/firmware/avr-limit-switch-interlock.asm',
    defaultDurationMs: 2,
    description: 'One explicit modeled D7 active-low LIMIT transition makes polling firmware force D2 STEP low and D4 active-low ENABLE high.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'Exactly one explicit D7 high-to-low input is scheduled only for this bundled fixture through AVRIOPort.setPin at a modeled clock event. Arbitrary AVR firmware receives no injected GPIO input.',
      'Requested/application/reaction cycles are avr8js polling evidence at a modeled 16 MHz clock. They are not calibrated response time, real-time deadline, interrupt latency, voltage threshold, contact, debounce, or safety evidence.',
      'The openable example is schematic-only and synthetic. It does not simulate or prove a switch, pull-up value, driver shutdown, motor stop, functional safety, PCB copper, or physical hardware.',
    ],
  },
  {
    id: 'avr-quadrature-detent-intent',
    label: 'AVR Quadrature Detent Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_QUADRATURE_DETENT_BYTES,
    sha256: AVR_QUADRATURE_DETENT_SHA256,
    sourcePath: 'examples/firmware/avr-quadrature-detent-intent.asm',
    defaultDurationMs: 1,
    description: 'One explicit clean D2/D3 quadrature phase order latches fixture-defined direction on D5 and completion on D6.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'Exactly four ordered D2/D3 input transitions are scheduled only for this bundled fixture through AVRIOPort.setPin at modeled clock events. Arbitrary AVR firmware receives no injected GPIO input.',
      'CW and CCW are fixture-defined names for which input leads. The sequence is one clean detent only; it does not model contacts, bounce, skipped/illegal states, acceleration, shaft motion, or mechanical direction.',
      'The openable example is schematic-only and synthetic. Emulator cycles and GPIO latches do not prove calibrated timing, voltage/current, an encoder, motion, PCB copper, or physical hardware.',
    ],
  },
  {
    id: 'avr-button-debounce-intent',
    label: 'AVR Button Debounce Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_BUTTON_DEBOUNCE_BYTES,
    sha256: AVR_BUTTON_DEBOUNCE_SHA256,
    sourcePath: 'examples/firmware/avr-button-debounce-intent.asm',
    defaultDurationMs: 1,
    description: 'One explicit clean or fixture-defined bouncing D7 press drives polling-firmware D4 accepted and D5 bounce-seen latches.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'The clean profile schedules one D7 falling edge; the bouncing profile schedules exactly five bounded low/high transitions through AVRIOPort.setPin. Arbitrary AVR firmware receives no injected GPIO input.',
      'The transition profiles and 64 consecutive polling samples are fixture-defined emulator intent. They do not model contact physics, analog voltage, pull-up resistance, calibrated debounce time, or a general debounce algorithm.',
      'The openable example is schematic-only and synthetic. It does not simulate or prove a physical button, safety input, interrupt behavior, PCB copper, or hardware.',
    ],
  },
  {
    id: 'avr-neopixel-frame-intent',
    label: 'AVR NeoPixel Frame Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_NEOPIXEL_FRAME_BYTES,
    sha256: AVR_NEOPIXEL_FRAME_SHA256,
    sourcePath: 'examples/firmware/avr-neopixel-frame-intent.asm',
    defaultDurationMs: 1,
    description: 'One fixture-defined 24-bit D6 pulse sequence decodes to GRB byte intent 20 10 40 at exact avr8js modeled cycles.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without an Arduino core, startup runtime, interrupts, external compiler, network, or download.',
      'Only this exact bundled fixture is decoded: 24 D6 high intervals of three or six modeled cycles produce one fixed GRB byte intent. Arbitrary firmware is not classified as NeoPixel traffic.',
      'Modeled-cycle pulse widths are not calibrated WS2812 timing or an electrical waveform. Voltage/current, signal integrity, reset/latch timing, and general protocol compatibility are not proven.',
      'The openable example is schematic-only and synthetic. It does not simulate an attached pixel, emitted light/color, a chain, PCB copper, or physical hardware.',
    ],
  },
  {
    id: 'avr-eeprom-roundtrip-intent',
    label: 'AVR EEPROM Round-trip Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_EEPROM_ROUNDTRIP_INTENT_BYTES,
    sha256: AVR_EEPROM_ROUNDTRIP_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-eeprom-roundtrip-intent.asm',
    defaultDurationMs: 5,
    description: 'One exact avr8js EEPROM erase-and-write/read-back at address 0x0010 with D6 success and D5 failure latches.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, external compiler, network, download, or application firmware.',
      'The checked-in source assembles byte-for-byte to the embedded 58-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of hardware persistence.',
      'EEPROM evidence comes from the avr8js in-memory backend and modeled controller cycles. It does not prove nonvolatile retention, endurance, wear, power-loss safety, atomicity, voltage, calibrated timing, or hardware behavior.',
      'The openable example is schematic-only and synthetic. D6 is firmware success intent only; it proves no attached indicator, PCB copper, package mapping, or physical device.',
    ],
  },
  {
    id: 'avr-watchdog-reset-intent',
    label: 'AVR Watchdog Reset Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_WATCHDOG_RESET_INTENT_BYTES,
    sha256: AVR_WATCHDOG_RESET_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-watchdog-reset-intent.asm',
    defaultDurationMs: 20,
    description: 'One exact avr8js watchdog system reset with firmware-observed MCUSR.WDRF and D5/D6 before/after latches.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, bootloader, startup runtime, external compiler, network, download, or application firmware.',
      'The checked-in source assembles byte-for-byte to the embedded 60-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of a hardware reset path.',
      'Watchdog evidence comes from avr8js AVRClock/AVRWatchdog and modeled CPU cycles. It does not prove calibrated timeout, oscillator tolerance, brownout/reset-pin behavior, bootloader/startup behavior, voltage, or hardware behavior.',
      'The openable example is schematic-only and synthetic. D5/D6 are firmware intent latches only; they prove no safety property, attached indicator, PCB copper, package mapping, persistence, or physical device.',
    ],
  },
  {
    id: 'avr-int0-interrupt-intent',
    label: 'AVR INT0 Interrupt Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_INT0_INTERRUPT_INTENT_BYTES,
    sha256: AVR_INT0_INTERRUPT_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-int0-interrupt-intent.asm',
    defaultDurationMs: 1,
    description: 'One fixture-scheduled D2 falling edge enters avr8js INT0 vector word 2 and drives ISR-only D5/D6 latches.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, startup runtime, external compiler, network, download, or application firmware.',
      'The checked-in source assembles byte-for-byte to the embedded 44-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of hardware interrupt behavior.',
      'Exactly one bounded D2 falling edge and one INT0 vector-entry event are classified only for this exact fixture. Arbitrary AVR firmware receives no injected input or classified interrupt event.',
      'Requested/applied/vector/latch cycles are avr8js controller/CPU evidence only. They do not prove calibrated latency, deadlines, priority/nesting, bounce/noise immunity, voltage thresholds, electrical edges, startup safety, PCB copper, or hardware.',
    ],
  },
  {
    id: 'avr-timer1-pulse-counter-intent',
    label: 'AVR Timer1 Pulse Counter Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_TIMER1_PULSE_COUNTER_INTENT_BYTES,
    sha256: AVR_TIMER1_PULSE_COUNTER_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-timer1-pulse-counter-intent.asm',
    defaultDurationMs: 1,
    description: 'One explicit 1–8 pulse D5/T1 stimulus drives Timer1 external rising-edge count, one firmware TCNT1 read, and D6/D7 completion/threshold latches.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, startup runtime, external compiler, network, download, or application firmware.',
      'The checked-in source assembles byte-for-byte to the embedded 54-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of hardware counting behavior.',
      'Exactly 1–8 clean D5/T1 pulses and one TCNT1 read event are classified only for this exact fixture. Arbitrary AVR firmware receives no injected pulse train or classified counter-read evidence.',
      'Requested/applied edges, Timer1 count, and D6/D7 latches are avr8js controller/firmware evidence only. They do not prove frequency, tachometer or RPM behavior, missed-pulse performance, calibrated timing, voltage thresholds, electrical edges, a sensor/load, PCB copper, or hardware.',
    ],
  },
  {
    id: 'avr-pcint-mask-intent',
    label: 'AVR PCINT Mask Intent',
    mcu: 'avr',
    imageFormat: 'avr-word-little-endian',
    bytes: AVR_PCINT_MASK_INTENT_BYTES,
    sha256: AVR_PCINT_MASK_INTENT_SHA256,
    sourcePath: 'examples/firmware/avr-pcint-mask-intent.asm',
    defaultDurationMs: 1,
    description: 'One masked D7/PCINT23 change and an optional enabled D4/PCINT20 change prove exact avr8js PCMSK2 selectivity and shared PCINT2 vector entry.',
    limitations: [
      'Runs a tiny ATmega328P image assembled locally by the already-installed avr8js assembler, without Arduino core, startup runtime, external compiler, network, download, or application firmware.',
      'The checked-in source assembles byte-for-byte to the embedded 62-byte image and recorded SHA-256; this is deterministic fixture provenance, not proof of hardware pin-change interrupts.',
      'The two bounded profiles inject only the exact D7 and D4 changes documented by the fixture. Arbitrary AVR firmware receives no injected input or classified PCINT2 vector evidence.',
      'Requested/applied/vector/latch cycles are avr8js controller/CPU evidence only. They do not prove calibrated latency, deadlines, simultaneous-edge ordering, priority/nesting, bounce/noise immunity, voltage thresholds, electrical edges, PCB copper, or hardware.',
    ],
  },
] as const;

export function getFirmwareFixture(id: string): FirmwareFixture | undefined {
  return FIRMWARE_FIXTURES.find((fixture) => fixture.id === id);
}

export function fixturesForMcu(mcu: McuTarget): readonly FirmwareFixture[] {
  return FIRMWARE_FIXTURES.filter((fixture) => fixture.mcu === mcu);
}
