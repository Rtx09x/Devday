import { listComponents, type AnyCircuitElement } from './circuitJson.ts';
import type { ProjectGuidance } from './projectGuidance.ts';

export const XIAO_I2C_TEMPLATE_ID = 'xiao-esp32-c3-i2c-controller-carrier' as const;
export const PICO_SENSOR_STATUS_TEMPLATE_ID = 'raspberry-pi-pico-rp2040-mixed-sensor-status-carrier' as const;
export const NANO_SENSOR_DISPLAY_TEMPLATE_ID = 'arduino-nano-avr-sensor-display-controller-carrier' as const;
export type ProjectTemplateId = typeof XIAO_I2C_TEMPLATE_ID | typeof PICO_SENSOR_STATUS_TEMPLATE_ID | typeof NANO_SENSOR_DISPLAY_TEMPLATE_ID;

export const PROJECT_TEMPLATE_REQUIRED_FIELDS = [
  'templateId',
  'powerSource',
  'interface',
  'connector',
  'environment',
  'quantity',
  'assembly',
  'targetFab',
  'maxWidthMm',
  'maxHeightMm',
] as const;

export const XIAO_I2C_TEMPLATE_AGENT_TARGET_IDENTITY = `project-template:${XIAO_I2C_TEMPLATE_ID}` as const;
export const PICO_SENSOR_STATUS_TEMPLATE_AGENT_TARGET_IDENTITY = `project-template:${PICO_SENSOR_STATUS_TEMPLATE_ID}` as const;
export const NANO_SENSOR_DISPLAY_TEMPLATE_AGENT_TARGET_IDENTITY = `project-template:${NANO_SENSOR_DISPLAY_TEMPLATE_ID}` as const;
export const PROJECT_TEMPLATE_BOARD = { widthMm: 40, heightMm: 30 } as const;
export const PICO_SENSOR_STATUS_BOARD = { widthMm: 75, heightMm: 45 } as const;
export const NANO_SENSOR_DISPLAY_BOARD = { widthMm: 70, heightMm: 45 } as const;

export const XIAO_I2C_TEMPLATE_FIXED_REQUIREMENTS = {
  templateId: XIAO_I2C_TEMPLATE_ID,
  powerSource: 'xiao-usb-c',
  interface: 'i2c-3v3',
  connector: 'generic-1x4-2.54mm',
  environment: 'indoor-benign',
  assembly: 'hand-soldered-prototype',
  targetFab: 'vendor-neutral-two-layer-prototype',
} as const;

export const PICO_SENSOR_STATUS_TEMPLATE_FIXED_REQUIREMENTS = {
  templateId: PICO_SENSOR_STATUS_TEMPLATE_ID,
  powerSource: 'pico-micro-usb-module',
  interface: 'analog-3v3-plus-pulled-up-digital',
  connector: 'generic-2.54mm-headers',
  environment: 'indoor-benign',
  assembly: 'hand-soldered-prototype',
  targetFab: 'vendor-neutral-two-layer-prototype',
} as const;

export const NANO_SENSOR_DISPLAY_TEMPLATE_FIXED_REQUIREMENTS = {
  templateId: NANO_SENSOR_DISPLAY_TEMPLATE_ID,
  powerSource: 'arduino-nano-usb-module-5v',
  interface: 'analog-5v-plus-i2c-5v-plus-pwm',
  connector: 'generic-2.54mm-headers',
  environment: 'indoor-benign',
  assembly: 'hand-soldered-prototype',
  targetFab: 'vendor-neutral-two-layer-prototype',
} as const;

export type XiaoI2cTemplateRequirements = typeof XIAO_I2C_TEMPLATE_FIXED_REQUIREMENTS & {
  quantity: number;
  maxWidthMm: number;
  maxHeightMm: number;
};

export type PicoSensorStatusTemplateRequirements = typeof PICO_SENSOR_STATUS_TEMPLATE_FIXED_REQUIREMENTS & {
  quantity: number;
  maxWidthMm: number;
  maxHeightMm: number;
};

export type NanoSensorDisplayTemplateRequirements = typeof NANO_SENSOR_DISPLAY_TEMPLATE_FIXED_REQUIREMENTS & {
  quantity: number;
  maxWidthMm: number;
  maxHeightMm: number;
};

export type ProjectTemplateRequirements = XiaoI2cTemplateRequirements | PicoSensorStatusTemplateRequirements | NanoSensorDisplayTemplateRequirements;

/** Backward-compatible alias retained for the first shipped template tests and callers. */
export const XIAO_I2C_TEMPLATE_REQUIRED_FIELDS = PROJECT_TEMPLATE_REQUIRED_FIELDS satisfies readonly (keyof ProjectTemplateRequirements)[];

export const XIAO_I2C_TEMPLATE_CONTRACT = {
  fixed: XIAO_I2C_TEMPLATE_FIXED_REQUIREMENTS,
  quantity: { integer: true, min: 1, max: 20 },
  maxWidthMm: { finite: true, min: PROJECT_TEMPLATE_BOARD.widthMm },
  maxHeightMm: { finite: true, min: PROJECT_TEMPLATE_BOARD.heightMm },
} as const;

export const PICO_SENSOR_STATUS_TEMPLATE_CONTRACT = {
  fixed: PICO_SENSOR_STATUS_TEMPLATE_FIXED_REQUIREMENTS,
  quantity: { integer: true, min: 1, max: 20 },
  maxWidthMm: { finite: true, min: PICO_SENSOR_STATUS_BOARD.widthMm },
  maxHeightMm: { finite: true, min: PICO_SENSOR_STATUS_BOARD.heightMm },
} as const;

export const NANO_SENSOR_DISPLAY_TEMPLATE_CONTRACT = {
  fixed: NANO_SENSOR_DISPLAY_TEMPLATE_FIXED_REQUIREMENTS,
  quantity: { integer: true, min: 1, max: 20 },
  maxWidthMm: { finite: true, min: NANO_SENSOR_DISPLAY_BOARD.widthMm },
  maxHeightMm: { finite: true, min: NANO_SENSOR_DISPLAY_BOARD.heightMm },
} as const;

const FIXED_REQUIREMENT_VALUES = [
  XIAO_I2C_TEMPLATE_FIXED_REQUIREMENTS,
  PICO_SENSOR_STATUS_TEMPLATE_FIXED_REQUIREMENTS,
  NANO_SENSOR_DISPLAY_TEMPLATE_FIXED_REQUIREMENTS,
] as const;
const enumValues = <K extends keyof typeof XIAO_I2C_TEMPLATE_FIXED_REQUIREMENTS>(key: K) => (
  [...new Set(FIXED_REQUIREMENT_VALUES.map((requirements) => requirements[key]))]
);

/**
 * The host SDK schema type has no oneOf. It advertises the union of values while
 * validateProjectTemplateRequirements enforces the exact template-specific tuple.
 */
export const PROJECT_TEMPLATE_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    templateId: { type: 'string' as const, enum: enumValues('templateId'), description: 'Exact selected project-template id.' },
    powerSource: { type: 'string' as const, enum: enumValues('powerSource'), description: 'Exact selected template power source; cross-template combinations are rejected.' },
    interface: { type: 'string' as const, enum: enumValues('interface'), description: 'Exact selected template interface; cross-template combinations are rejected.' },
    connector: { type: 'string' as const, enum: enumValues('connector'), description: 'Exact selected template connector model; cross-template combinations are rejected.' },
    environment: { type: 'string' as const, enum: enumValues('environment'), description: 'Benign indoor prototype environment only.' },
    quantity: { type: 'number' as const, description: 'Integer prototype quantity, inclusive 1 through 20.' },
    assembly: { type: 'string' as const, enum: enumValues('assembly'), description: 'Hand-soldered prototype assembly.' },
    targetFab: { type: 'string' as const, enum: enumValues('targetFab'), description: 'Vendor-neutral two-layer prototype target.' },
    maxWidthMm: { type: 'number' as const, description: 'Finite maximum board width in mm; the selected template-specific minimum applies.' },
    maxHeightMm: { type: 'number' as const, description: 'Finite maximum board height in mm; the selected template-specific minimum applies.' },
  },
  required: [...PROJECT_TEMPLATE_REQUIRED_FIELDS],
};

/** Backward-compatible schema export; now intentionally advertises both registry entries. */
export const XIAO_I2C_TEMPLATE_TOOL_INPUT_SCHEMA = PROJECT_TEMPLATE_TOOL_INPUT_SCHEMA;

export interface ProjectTemplateDefinition {
  id: ProjectTemplateId;
  label: string;
  description: string;
  suggestedPrompt: string;
  sessionName: string;
  cardTitle: string;
  cardDescription: string;
  defaultRequest: string;
  board: { widthMm: number; heightMm: number };
  limitations: readonly string[];
}

export interface ProjectTemplatePreviewMetadata {
  templateId: ProjectTemplateId;
  requirements: ProjectTemplateRequirements;
  expectedRefs: string[];
  board: { widthMm: number; heightMm: number; layers: 2 };
  limitations: string[];
}

export const XIAO_I2C_TEMPLATE: ProjectTemplateDefinition = {
  id: XIAO_I2C_TEMPLATE_ID,
  label: 'XIAO ESP32-C3 indoor I²C carrier',
  description: '40 × 30 mm socketed controller carrier; the agent stages the complete readable TSX for review.',
  suggestedPrompt: 'Ask the agent to propose the XIAO ESP32-C3 indoor I²C controller carrier, confirm every required field, and stage it for approval.',
  sessionName: 'XIAO ESP32-C3 I²C template request',
  cardTitle: 'Ask agent to start the XIAO ESP32-C3 I²C carrier',
  cardDescription: 'Describe quantity and board-size limits. The agent must collect every missing requirement, call the exact template tool, and stop at the approval preview. Selection alone confirms nothing.',
  defaultRequest: 'I want to use this template.\nPrototype quantity: [enter 1–20]\nMaximum board width: [enter at least 40 mm]\nMaximum board height: [enter at least 30 mm]\nAsk me to confirm every fixed power, interface, connector, environment, assembly, and fabrication value before proposing. Do not infer missing values.',
  board: PROJECT_TEMPLATE_BOARD,
  limitations: [
    'The XIAO is a plug-in module represented by two socket headers; this is not integrated ESP32 circuitry.',
    'USB-C behavior, power budget, regulator limits, firmware, module mechanics, antenna clearance, and enclosure fit are not verified.',
    'The external I²C footprint is a generic 1×4 2.54 mm header, not a Qwiic/JST-SH mechanical guarantee.',
    'Pull-up suitability depends on cable length, bus capacitance, and I²C speed.',
    'Evaluation proves the generated source projection and expected connectivity, not ERC, DRC, routing, manufacturing, or physical correctness.',
  ],
};

export const PICO_SENSOR_STATUS_TEMPLATE: ProjectTemplateDefinition = {
  id: PICO_SENSOR_STATUS_TEMPLATE_ID,
  label: 'Raspberry Pi Pico mixed-sensor/status carrier',
  description: '75 × 45 mm socketed Pico/Pico H carrier with analog, pulled-up digital, contact, and status headers.',
  suggestedPrompt: 'Ask the agent to propose the Raspberry Pi Pico mixed-sensor/status carrier, confirm every required field, and stage it for approval.',
  sessionName: 'Set up Raspberry Pi Pico sensor/status carrier',
  cardTitle: 'Ask agent to start the Raspberry Pi Pico sensor/status carrier',
  cardDescription: 'Describe quantity and board-size limits. The agent must collect every exact requirement, call only the project-template tool, and stop at the approval preview. Selection alone confirms nothing.',
  defaultRequest: 'I want to use the Raspberry Pi Pico mixed-sensor/status carrier.\nPrototype quantity: [enter 1–20]\nMaximum board width: [enter at least 75 mm]\nMaximum board height: [enter at least 45 mm]\nAsk me to confirm the exact Pico module power, mixed-sensor interface, generic-header, indoor-environment, hand-assembly, and prototype-fabrication values before proposing. Do not infer missing values.',
  board: PICO_SENSOR_STATUS_BOARD,
  limitations: [
    'The Raspberry Pi Pico/Pico H is a plug-in module represented only by generic 20-pin socket headers H1/H2; no RP2040 or module circuitry is modeled.',
    'Micro USB behavior, module power budget, regulator limits, firmware, module outline, socket mechanics, connector access, enclosure fit, and mechanical fit are not verified.',
    'The sensor, contact, and status footprints are generic 2.54 mm headers; no attached sensor, switch, cable, or connector mechanics are modeled.',
    'Analog accuracy, ADC reference quality, voltage tolerance, pull-up suitability, cable behavior, GPIO drive, and attached-device compatibility are not verified.',
    'This template makes no Pico W compatibility or antenna claim.',
    'Evaluation proves the generated source projection, exact source ports, geometry, and expected connectivity, not ERC, DRC, routing, copper, manufacturing, firmware, simulation, or physical correctness.',
  ],
};

export const NANO_SENSOR_DISPLAY_TEMPLATE: ProjectTemplateDefinition = {
  id: NANO_SENSOR_DISPLAY_TEMPLATE_ID,
  label: 'Arduino Nano sensor/display controller carrier',
  description: '70 × 45 mm socketed Nano-style carrier with analog, 5 V I²C, contact, PWM/status, and local rail capacitors.',
  suggestedPrompt: 'Ask the agent to propose the Arduino Nano sensor/display controller carrier, confirm every required field, and stage it for approval.',
  sessionName: 'Set up Arduino Nano sensor/display carrier',
  cardTitle: 'Ask agent to start the Arduino Nano sensor/display carrier',
  cardDescription: 'Describe quantity and board-size limits. The agent must collect every exact requirement, call only the project-template tool, and stop at the approval preview. Selection alone confirms nothing.',
  defaultRequest: 'I want to use the Arduino Nano sensor/display controller carrier.\nPrototype quantity: [enter 1–20]\nMaximum board width: [enter at least 70 mm]\nMaximum board height: [enter at least 45 mm]\nAsk me to confirm the exact Nano-module USB power, analog/I²C/PWM interface, generic-header, indoor-environment, hand-assembly, and prototype-fabrication values before proposing. Do not infer missing values.',
  board: NANO_SENSOR_DISPLAY_BOARD,
  limitations: [
    'The Arduino Nano-style controller is a plug-in module represented only by generic female socket headers H1/H2; no ATmega328P, USB-serial, regulator, reset/boot, or module circuitry is modeled.',
    'The intended Nano or clone pinout, orientation, 15.24 mm row spacing, module outline, USB access, socket fit, clearance, and reverse-insertion behavior must be checked against the actual module.',
    'USB power budget, current, rail tolerance, protection, and attached-load compatibility are not verified; J4 is a logic-level PWM/status output and must not directly drive a motor, relay, or high-current LED.',
    'I²C voltage tolerance, pull-up suitability, capacitance, speed, cable behavior, analog input range, source impedance, reference quality, and calibration are not verified.',
    'Headers and passives are generic declarations without manufacturer part numbers, local evidence, ordering claims, or connector and cable mechanics.',
    'Evaluation proves the generated source projection, exact source ports, geometry, values, footprints, and expected connectivity, not ERC, DRC, routing, copper, manufacturing, firmware, simulation, hardware, or physical correctness.',
  ],
};

export const PROJECT_TEMPLATES = [XIAO_I2C_TEMPLATE, PICO_SENSOR_STATUS_TEMPLATE, NANO_SENSOR_DISPLAY_TEMPLATE] as const;

export function getProjectTemplate(id: ProjectTemplateId): ProjectTemplateDefinition {
  const template = PROJECT_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`Unknown project template "${id}".`);
  return template;
}

export function projectTemplateAgentTargetIdentity(id: ProjectTemplateId): `project-template:${ProjectTemplateId}` {
  return `project-template:${id}`;
}

export const XIAO_I2C_EXPECTED_REFS = ['H1', 'H2', 'J1', 'J2', 'R1', 'R2', 'R3', 'R4', 'LED1', 'C1'] as const;
export const XIAO_I2C_EXPECTED_TRACE_COUNT = 17;
export const XIAO_I2C_EXPECTED_CONNECTIONS = [
  'C1.pin1 <-> H2.3V3', 'C1.pin2 <-> H2.GND', 'H1.D4_GPIO6_SDA <-> J1.SDA',
  'H1.D5_GPIO7_SCL <-> J1.SCL', 'H1.D6_GPIO21_STATUS <-> R3.pin1', 'H2.3V3 <-> J1.3V3',
  'H2.3V3 <-> R1.pin1', 'H2.3V3 <-> R2.pin1', 'H2.3V3 <-> R4.pin1', 'H2.GND <-> J1.GND',
  'H2.GND <-> J2.GND', 'H1.D3_GPIO5 <-> J2.INPUT', 'H2.GND <-> LED1.pin2',
  'H1.D4_GPIO6_SDA <-> R1.pin2', 'H1.D5_GPIO7_SCL <-> R2.pin2', 'LED1.pin1 <-> R3.pin2',
  'H1.D3_GPIO5 <-> R4.pin2',
] as const;

export const PICO_SENSOR_STATUS_H1_PIN_LABELS = [
  'GP0_PIN1', 'GP1_PIN2', 'GND_PIN3', 'GP2_PIN4', 'GP3_PIN5', 'GP4_PIN6', 'GP5_PIN7',
  'GND_PIN8', 'GP6_PIN9', 'GP7_PIN10', 'GP8_PIN11', 'GP9_PIN12', 'GND_PIN13', 'GP10_PIN14',
  'GP11_PIN15', 'GP12_PIN16', 'GP13_PIN17', 'GND_PIN18', 'GP14_PIN19', 'GP15_PIN20',
] as const;
export const PICO_SENSOR_STATUS_H2_PIN_LABELS = [
  'VBUS_PIN40', 'VSYS_PIN39', 'GND_PIN38', '3V3_EN_PIN37', '3V3_OUT_PIN36', 'ADC_VREF_PIN35',
  'GP28_ADC2_PIN34', 'AGND_PIN33', 'GP27_ADC1_PIN32', 'GP26_ADC0_PIN31', 'RUN_PIN30', 'GP22_PIN29',
  'GND_PIN28', 'GP21_PIN27', 'GP20_PIN26', 'GP19_PIN25', 'GP18_PIN24', 'GND_PIN23', 'GP17_PIN22', 'GP16_PIN21',
] as const;
export const PICO_SENSOR_STATUS_REQUIRED_SOURCE_PORTS = [
  'H1.GND_PIN18', 'H1.GP14_PIN19', 'H1.GP15_PIN20',
  'H2.3V3_OUT_PIN36', 'H2.GND_PIN38', 'H2.GP16_PIN21', 'H2.GP26_ADC0_PIN31',
] as const;
export const PICO_SENSOR_STATUS_EXPECTED_REFS = ['H1', 'H2', 'J1', 'J2', 'J3', 'J4', 'R1', 'R2', 'R3', 'LED1', 'C1'] as const;
export const PICO_SENSOR_STATUS_EXPECTED_TRACE_COUNT = 19;
export const PICO_SENSOR_STATUS_EXPECTED_CONNECTIONS = [
  'C1.pin1 <-> H2.3V3_OUT_PIN36', 'C1.pin2 <-> H2.GND_PIN38',
  'H2.3V3_OUT_PIN36 <-> J1.3V3', 'H2.GND_PIN38 <-> J1.GND', 'H2.GP26_ADC0_PIN31 <-> J1.ANALOG',
  'H2.3V3_OUT_PIN36 <-> J2.3V3', 'H2.GND_PIN38 <-> J2.GND', 'H2.GP16_PIN21 <-> J2.DATA',
  'H2.3V3_OUT_PIN36 <-> R1.pin1', 'H2.GP16_PIN21 <-> R1.pin2',
  'H1.GP15_PIN20 <-> R2.pin1', 'LED1.pin1 <-> R2.pin2', 'H1.GND_PIN18 <-> LED1.pin2',
  'H1.GP15_PIN20 <-> J4.STATUS', 'H1.GND_PIN18 <-> J4.GND',
  'H1.GP14_PIN19 <-> J3.CONTACT', 'H1.GND_PIN18 <-> J3.GND',
  'H2.3V3_OUT_PIN36 <-> R3.pin1', 'H1.GP14_PIN19 <-> R3.pin2',
] as const;

export const PICO_SENSOR_STATUS_EXPECTED_GEOMETRY = {
  H1: { x: -8, y: -8.89, rotation: 0 }, H2: { x: -8, y: 8.89, rotation: 0 },
  J1: { x: 32, y: 13, rotation: 90 }, J2: { x: 32, y: 4, rotation: 90 },
  J3: { x: 32, y: -5, rotation: 90 }, J4: { x: 32, y: -14, rotation: 90 },
  R1: { x: 20, y: 5, rotation: 0 }, R2: { x: 20, y: -10, rotation: 0 },
  R3: { x: 20, y: -3, rotation: 0 }, LED1: { x: 26, y: -10, rotation: 0 },
  C1: { x: 20, y: 14, rotation: 0 },
} as const;
export const PICO_SENSOR_STATUS_EXPECTED_FOOTPRINTS = {
  H1: 'pinrow20_p2.54', H2: 'pinrow20_p2.54',
  J1: 'pinrow3_p2.54', J2: 'pinrow3_p2.54',
  J3: 'pinrow2_p2.54', J4: 'pinrow2_p2.54',
  R1: 'res0603', R2: 'res0603', R3: 'res0603',
  LED1: '0603_color(green)', C1: '0603',
} as const;

export const NANO_SENSOR_DISPLAY_H1_PIN_LABELS = [
  'D1_TX_MODULE_PIN1', 'D0_RX_MODULE_PIN2', 'RESET_MODULE_PIN3', 'GND_MODULE_PIN4',
  'D2_MODULE_PIN5', 'D3_PWM_MODULE_PIN6', 'D4_MODULE_PIN7', 'D5_PWM_MODULE_PIN8',
  'D6_PWM_MODULE_PIN9', 'D7_MODULE_PIN10', 'D8_MODULE_PIN11', 'D9_PWM_MODULE_PIN12',
  'D10_PWM_SS_MODULE_PIN13', 'D11_PWM_MOSI_MODULE_PIN14', 'D12_MISO_MODULE_PIN15',
] as const;
export const NANO_SENSOR_DISPLAY_H2_PIN_LABELS = [
  'D13_SCK_LED_MODULE_PIN16', '3V3_MODULE_PIN17', 'AREF_MODULE_PIN18', 'A0_MODULE_PIN19',
  'A1_MODULE_PIN20', 'A2_MODULE_PIN21', 'A3_MODULE_PIN22', 'A4_SDA_MODULE_PIN23',
  'A5_SCL_MODULE_PIN24', 'A6_MODULE_PIN25', 'A7_MODULE_PIN26', '5V_MODULE_PIN27',
  'RESET_MODULE_PIN28', 'GND_MODULE_PIN29', 'VIN_MODULE_PIN30',
] as const;
export const NANO_SENSOR_DISPLAY_REQUIRED_SOURCE_PORTS = [
  'H1.D2_MODULE_PIN5', 'H1.D6_PWM_MODULE_PIN9', 'H2.A0_MODULE_PIN19',
  'H2.A4_SDA_MODULE_PIN23', 'H2.A5_SCL_MODULE_PIN24',
  'H2.5V_MODULE_PIN27', 'H2.GND_MODULE_PIN29',
] as const;
export const NANO_SENSOR_DISPLAY_EXPECTED_REFS = [
  'H1', 'H2', 'J1', 'J2', 'J3', 'J4', 'R1', 'R2', 'R3', 'R4', 'LED1', 'C1', 'C2',
] as const;
export const NANO_SENSOR_DISPLAY_EXPECTED_TRACE_COUNT = 24;
export const NANO_SENSOR_DISPLAY_EXPECTED_CONNECTIONS = [
  'H2.5V_MODULE_PIN27 <-> J1.5V', 'H2.GND_MODULE_PIN29 <-> J1.GND',
  'H2.A4_SDA_MODULE_PIN23 <-> J1.SDA', 'H2.A5_SCL_MODULE_PIN24 <-> J1.SCL',
  'H2.5V_MODULE_PIN27 <-> R1.pin1', 'H2.A4_SDA_MODULE_PIN23 <-> R1.pin2',
  'H2.5V_MODULE_PIN27 <-> R2.pin1', 'H2.A5_SCL_MODULE_PIN24 <-> R2.pin2',
  'H2.5V_MODULE_PIN27 <-> J2.5V', 'H2.GND_MODULE_PIN29 <-> J2.GND',
  'H2.A0_MODULE_PIN19 <-> J2.ANALOG', 'H1.D2_MODULE_PIN5 <-> J3.BUTTON',
  'H2.GND_MODULE_PIN29 <-> J3.GND', 'H2.5V_MODULE_PIN27 <-> R3.pin1',
  'H1.D2_MODULE_PIN5 <-> R3.pin2', 'H1.D6_PWM_MODULE_PIN9 <-> R4.pin1',
  'LED1.pin1 <-> R4.pin2', 'H2.GND_MODULE_PIN29 <-> LED1.pin2',
  'H1.D6_PWM_MODULE_PIN9 <-> J4.PWM', 'H2.GND_MODULE_PIN29 <-> J4.GND',
  'C1.pin1 <-> H2.5V_MODULE_PIN27', 'C1.pin2 <-> H2.GND_MODULE_PIN29',
  'C2.pin1 <-> H2.5V_MODULE_PIN27', 'C2.pin2 <-> H2.GND_MODULE_PIN29',
] as const;
export const NANO_SENSOR_DISPLAY_EXPECTED_GEOMETRY = {
  H1: { x: -8, y: -7.62, rotation: 0 }, H2: { x: -8, y: 7.62, rotation: 0 },
  J1: { x: 30, y: 15, rotation: 90 }, J2: { x: 30, y: 4, rotation: 90 },
  J3: { x: 30, y: -5, rotation: 90 }, J4: { x: 30, y: -14, rotation: 90 },
  R1: { x: 12, y: 12, rotation: 0 }, R2: { x: 18, y: 12, rotation: 0 },
  R3: { x: 18, y: -4, rotation: 0 }, R4: { x: 12, y: -13, rotation: 0 },
  LED1: { x: 18, y: -13, rotation: 0 }, C1: { x: 6, y: 15, rotation: 0 },
  C2: { x: 0, y: 15, rotation: 0 },
} as const;
export const NANO_SENSOR_DISPLAY_EXPECTED_FOOTPRINTS = {
  H1: 'pinrow15_p2.54', H2: 'pinrow15_p2.54',
  J1: 'pinrow4_p2.54', J2: 'pinrow3_p2.54',
  J3: 'pinrow2_p2.54', J4: 'pinrow2_p2.54',
  R1: 'res0603', R2: 'res0603', R3: 'res0603', R4: 'res0603',
  LED1: '0603_color(green)', C1: '0603', C2: '0805',
} as const;

function getProjectTemplateContract(id: ProjectTemplateId) {
  switch (id) {
    case XIAO_I2C_TEMPLATE_ID: return XIAO_I2C_TEMPLATE_CONTRACT;
    case PICO_SENSOR_STATUS_TEMPLATE_ID: return PICO_SENSOR_STATUS_TEMPLATE_CONTRACT;
    case NANO_SENSOR_DISPLAY_TEMPLATE_ID: return NANO_SENSOR_DISPLAY_TEMPLATE_CONTRACT;
  }
}

export function projectTemplateContractLines(id: ProjectTemplateId = XIAO_I2C_TEMPLATE_ID): string[] {
  const contract = getProjectTemplateContract(id);
  const fixed = contract.fixed;
  return [
    `templateId must be exactly ${fixed.templateId}`,
    `powerSource must be exactly ${fixed.powerSource}`,
    `interface must be exactly ${fixed.interface}`,
    `connector must be exactly ${fixed.connector}`,
    `environment must be exactly ${fixed.environment}`,
    `quantity must be an explicitly confirmed integer from ${contract.quantity.min} through ${contract.quantity.max}`,
    `assembly must be exactly ${fixed.assembly}`,
    `targetFab must be exactly ${fixed.targetFab}`,
    `maxWidthMm must be an explicitly confirmed finite number at least ${contract.maxWidthMm.min}`,
    `maxHeightMm must be an explicitly confirmed finite number at least ${contract.maxHeightMm.min}`,
  ];
}

export function validateProjectTemplateRequirements(value: unknown): ProjectTemplateRequirements {
  if (!isRecord(value)) throw new Error('Template requirements must be an object with every required field.');
  if (value.templateId !== XIAO_I2C_TEMPLATE_ID && value.templateId !== PICO_SENSOR_STATUS_TEMPLATE_ID && value.templateId !== NANO_SENSOR_DISPLAY_TEMPLATE_ID) {
    throw new Error(`templateId must be exactly "${XIAO_I2C_TEMPLATE_ID}", "${PICO_SENSOR_STATUS_TEMPLATE_ID}", or "${NANO_SENSOR_DISPLAY_TEMPLATE_ID}".`);
  }
  const contract = getProjectTemplateContract(value.templateId);
  const fixed = contract.fixed;
  exact(value.powerSource, 'powerSource', fixed.powerSource);
  exact(value.interface, 'interface', fixed.interface);
  exact(value.connector, 'connector', fixed.connector);
  exact(value.environment, 'environment', fixed.environment);
  exact(value.assembly, 'assembly', fixed.assembly);
  exact(value.targetFab, 'targetFab', fixed.targetFab);
  const quantity = finite(value.quantity, 'quantity');
  if (!Number.isInteger(quantity) || quantity < contract.quantity.min || quantity > contract.quantity.max) {
    throw new Error(`quantity must be an integer from ${contract.quantity.min} through ${contract.quantity.max}.`);
  }
  const maxWidthMm = finite(value.maxWidthMm, 'maxWidthMm');
  const maxHeightMm = finite(value.maxHeightMm, 'maxHeightMm');
  if (maxWidthMm < contract.maxWidthMm.min) throw new Error(`maxWidthMm must be at least ${contract.maxWidthMm.min} for the fixed template board.`);
  if (maxHeightMm < contract.maxHeightMm.min) throw new Error(`maxHeightMm must be at least ${contract.maxHeightMm.min} for the fixed template board.`);
  return { ...fixed, quantity, maxWidthMm, maxHeightMm } as ProjectTemplateRequirements;
}

/** Reject only deterministic structured contradictions; never fuzzy-match guidance strings. */
export function assertNoProjectGuidanceContradiction(requirements: ProjectTemplateRequirements, guidance?: ProjectGuidance): void {
  const loaded = guidance?.requirements;
  if (!loaded) return;
  const board = getProjectTemplate(requirements.templateId).board;
  if (loaded.quantity != null && loaded.quantity !== requirements.quantity) {
    throw new Error(`Loaded project guidance requires quantity ${loaded.quantity}, but the template request specifies ${requirements.quantity}. Resolve the explicit contradiction first.`);
  }
  if (loaded.board?.maxWidthMm != null && loaded.board.maxWidthMm < board.widthMm) {
    throw new Error(`Loaded project guidance limits width to ${loaded.board.maxWidthMm} mm, below the fixed ${board.widthMm} mm template width.`);
  }
  if (loaded.board?.maxHeightMm != null && loaded.board.maxHeightMm < board.heightMm) {
    throw new Error(`Loaded project guidance limits height to ${loaded.board.maxHeightMm} mm, below the fixed ${board.heightMm} mm template height.`);
  }
}

export function classifyBlankEditableTsx(source: string): { eligible: boolean; reason?: string } {
  if (!source.trim()) return { eligible: true };
  const normalized = source.replace(/\r\n/g, '\n').trim();
  const match = normalized.match(/^export\s+default\s+\(\s*\)\s*=>\s*\(\s*<board\b([^>]*)>([\s\S]*?)<\/board>\s*\)\s*;?$/);
  const selfClosing = normalized.match(/^export\s+default\s+\(\s*\)\s*=>\s*\(\s*<board\b([^>]*)\/>\s*\)\s*;?$/);
  const attrs = match?.[1] ?? selfClosing?.[1];
  const body = match?.[2] ?? '';
  if (attrs == null || body.trim()) return { eligible: false, reason: 'The open TSX is not an exact empty single-board document.' };
  const remainder = attrs.replace(/\bwidth\s*=\s*(?:"[^"]*"|'[^']*')/g, '').replace(/\bheight\s*=\s*(?:"[^"]*"|'[^']*')/g, '').trim();
  if (remainder) return { eligible: false, reason: 'The empty board has unsupported or executable properties.' };
  return { eligible: true };
}

export function generateProjectTemplateSource(requirements: ProjectTemplateRequirements): string {
  const req = validateProjectTemplateRequirements(requirements);
  switch (req.templateId) {
    case XIAO_I2C_TEMPLATE_ID: return generateXiaoSource(req);
    case PICO_SENSOR_STATUS_TEMPLATE_ID: return generatePicoSource(req);
    case NANO_SENSOR_DISPLAY_TEMPLATE_ID: return generateNanoSource(req);
  }
}

function generateXiaoSource(req: XiaoI2cTemplateRequirements): string {
  return `/*
 * Template: ${req.templateId}
 * Requirements: power=${req.powerSource}; interface=${req.interface}; connector=${req.connector};
 * environment=${req.environment}; quantity=${req.quantity}; assembly=${req.assembly};
 * target=${req.targetFab}; maximum=${req.maxWidthMm}x${req.maxHeightMm}mm; fixed board=40x30mm.
 *
 * The XIAO ESP32-C3 is a plug-in module represented only by socket headers H1/H2.
 * USB-C power comes from that module. Unused XIAO pins are intentionally unconnected.
 * Firmware must configure D4/D5 for I2C, D6 for the status LED, and D3 for the input.
 * This starter does not prove module mechanics/antenna clearance, ERC/DRC, routing,
 * manufacturing, firmware behavior, power budget, or physical correctness.
 */
export default () => (
  <board width="40mm" height="30mm">
    {/* XIAO ESP32-C3 plug-in module sockets; 15.24 mm row spacing. */}
    <pinheader name="H1" pinCount={7}
      pinLabels={["D0_GPIO2", "D1_GPIO3", "D2_GPIO4", "D3_GPIO5", "D4_GPIO6_SDA", "D5_GPIO7_SCL", "D6_GPIO21_STATUS"]}
      footprint="pinrow7_p2.54" schX={-10} schY={0} pcbX={-7.62} pcbY={0} pcbRotation={90} />
    <pinheader name="H2" pinCount={7}
      pinLabels={["D10_GPIO10", "D9_GPIO9", "D8_GPIO8", "D7_GPIO20", "3V3", "GND", "5V"]}
      footprint="pinrow7_p2.54" schX={10} schY={0} pcbX={7.62} pcbY={0} pcbRotation={90} />

    {/* Generic 2.54 mm I2C connector: no Qwiic/JST-SH mechanical claim. */}
    <pinheader name="J1" pinCount={4} pinLabels={["3V3", "GND", "SDA", "SCL"]}
      footprint="pinrow4_p2.54" schX={22} schY={8} pcbX={15} pcbY={8} pcbRotation={90} />
    <resistor name="R1" resistance="4.7k" footprint="0603" schX={-1} schY={8} pcbX={-2} pcbY={8} />
    <resistor name="R2" resistance="4.7k" footprint="0603" schX={5} schY={8} pcbX={2} pcbY={8} />

    {/* Status indication on D6, current-limited for the 3.3 V GPIO. */}
    <resistor name="R3" resistance="1k" footprint="0603" schX={-2} schY={-8} pcbX={-3} pcbY={-8} />
    <led name="LED1" footprint="0603" color="green" schX={5} schY={-8} pcbX={2} pcbY={-8} />

    {/* Pulled-up digital input on D3 with a generic signal/GND header. */}
    <pinheader name="J2" pinCount={2} pinLabels={["INPUT", "GND"]}
      footprint="pinrow2_p2.54" schX={22} schY={-8} pcbX={15} pcbY={-8} pcbRotation={90} />
    <resistor name="R4" resistance="10k" footprint="0603" schX={12} schY={-5} pcbX={8} pcbY={-11} />

    {/* Local carrier decoupling across the module 3V3/GND rails. */}
    <capacitor name="C1" capacitance="100nF" footprint="0603" schX={12} schY={5} pcbX={-8} pcbY={11} />

    {/* I2C power, ground, signals, and 4.7 kOhm pull-ups. */}
    <trace from=".H2 > .3V3" to=".J1 > .3V3" />
    <trace from=".H2 > .GND" to=".J1 > .GND" />
    <trace from=".H1 > .D4_GPIO6_SDA" to=".J1 > .SDA" />
    <trace from=".H1 > .D5_GPIO7_SCL" to=".J1 > .SCL" />
    <trace from=".H2 > .3V3" to=".R1 > .pin1" />
    <trace from=".R1 > .pin2" to=".H1 > .D4_GPIO6_SDA" />
    <trace from=".H2 > .3V3" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to=".H1 > .D5_GPIO7_SCL" />

    {/* Status LED and pulled-up digital input. */}
    <trace from=".H1 > .D6_GPIO21_STATUS" to=".R3 > .pin1" />
    <trace from=".R3 > .pin2" to=".LED1 > .anode" />
    <trace from=".LED1 > .cathode" to=".H2 > .GND" />
    <trace from=".H2 > .3V3" to=".R4 > .pin1" />
    <trace from=".R4 > .pin2" to=".H1 > .D3_GPIO5" />
    <trace from=".J2 > .INPUT" to=".H1 > .D3_GPIO5" />
    <trace from=".J2 > .GND" to=".H2 > .GND" />

    {/* 100 nF local decoupling. */}
    <trace from=".C1 > .pin1" to=".H2 > .3V3" />
    <trace from=".C1 > .pin2" to=".H2 > .GND" />
  </board>
)
`;
}

function generatePicoSource(req: PicoSensorStatusTemplateRequirements): string {
  return `/*
 * Template: ${req.templateId}
 * Requirements: power=${req.powerSource}; interface=${req.interface}; connector=${req.connector};
 * environment=${req.environment}; quantity=${req.quantity}; assembly=${req.assembly};
 * target=${req.targetFab}; maximum=${req.maxWidthMm}x${req.maxHeightMm}mm; fixed board=75x45mm.
 *
 * Raspberry Pi Pico/Pico H is a plug-in module represented only by generic 20-pin
 * socket headers H1/H2 with unique physical-pin-suffixed labels. The carrier uses
 * the module's 3V3_OUT and GND pins; module USB and internal circuitry are not modeled.
 * Firmware must configure GP26 as ADC0, GP16 for the pulled-up digital sensor,
 * GP14 for the contact input, and GP15 for status. This starter does not prove
 * module or socket mechanics, mechanical fit, ERC/DRC, routing, copper,
 * manufacturing, firmware, simulation, power budget, or physical correctness.
 */
export default () => (
  <board width="75mm" height="45mm">
    {/* Plug-in Pico/Pico H socket rows only; no integrated RP2040/module model. */}
    <pinheader name="H1" pinCount={20} gender="female"
      pinLabels={${JSON.stringify(PICO_SENSOR_STATUS_H1_PIN_LABELS)}}
      footprint="pinrow20_p2.54" schX={-18} schY={0} pcbX={-8} pcbY={-8.89} pcbRotation={0} />
    <pinheader name="H2" pinCount={20} gender="female"
      pinLabels={${JSON.stringify(PICO_SENSOR_STATUS_H2_PIN_LABELS)}}
      footprint="pinrow20_p2.54" schX={18} schY={0} pcbX={-8} pcbY={8.89} pcbRotation={0} />

    {/* Generic 2.54 mm sensor/contact/status headers; no attached devices modeled. */}
    <pinheader name="J1" pinCount={3} pinLabels={["3V3", "GND", "ANALOG"]}
      footprint="pinrow3_p2.54" schX={42} schY={13} pcbX={32} pcbY={13} pcbRotation={90} />
    <pinheader name="J2" pinCount={3} pinLabels={["3V3", "GND", "DATA"]}
      footprint="pinrow3_p2.54" schX={42} schY={4} pcbX={32} pcbY={4} pcbRotation={90} />
    <pinheader name="J3" pinCount={2} pinLabels={["CONTACT", "GND"]}
      footprint="pinrow2_p2.54" schX={42} schY={-5} pcbX={32} pcbY={-5} pcbRotation={90} />
    <pinheader name="J4" pinCount={2} pinLabels={["STATUS", "GND"]}
      footprint="pinrow2_p2.54" schX={42} schY={-14} pcbX={32} pcbY={-14} pcbRotation={90} />

    <resistor name="R1" resistance="4.7k" footprint="0603" schX={7} schY={7} pcbX={20} pcbY={5} />
    <resistor name="R2" resistance="1k" footprint="0603" schX={7} schY={-10} pcbX={20} pcbY={-10} />
    <resistor name="R3" resistance="10k" footprint="0603" schX={7} schY={-3} pcbX={20} pcbY={-3} />
    <led name="LED1" footprint="0603" color="green" schX={14} schY={-10} pcbX={26} pcbY={-10} />
    <capacitor name="C1" capacitance="100nF" footprint="0603" schX={7} schY={14} pcbX={20} pcbY={14} />

    {/* Analog sensor header on GP26/ADC0. */}
    <trace from=".H2 > .3V3_OUT_PIN36" to=".J1 > .3V3" />
    <trace from=".H2 > .GND_PIN38" to=".J1 > .GND" />
    <trace from=".H2 > .GP26_ADC0_PIN31" to=".J1 > .ANALOG" />

    {/* Pulled-up digital sensor header on GP16. */}
    <trace from=".H2 > .3V3_OUT_PIN36" to=".J2 > .3V3" />
    <trace from=".H2 > .GND_PIN38" to=".J2 > .GND" />
    <trace from=".H2 > .GP16_PIN21" to=".J2 > .DATA" />
    <trace from=".H2 > .3V3_OUT_PIN36" to=".R1 > .pin1" />
    <trace from=".H2 > .GP16_PIN21" to=".R1 > .pin2" />

    {/* Current-limited local LED and mirrored status/GND header on GP15. */}
    <trace from=".H1 > .GP15_PIN20" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to=".LED1 > .anode" />
    <trace from=".H1 > .GND_PIN18" to=".LED1 > .cathode" />
    <trace from=".H1 > .GP15_PIN20" to=".J4 > .STATUS" />
    <trace from=".H1 > .GND_PIN18" to=".J4 > .GND" />

    {/* Pulled-up external dry-contact input header on GP14. */}
    <trace from=".H1 > .GP14_PIN19" to=".J3 > .CONTACT" />
    <trace from=".H1 > .GND_PIN18" to=".J3 > .GND" />
    <trace from=".H2 > .3V3_OUT_PIN36" to=".R3 > .pin1" />
    <trace from=".H1 > .GP14_PIN19" to=".R3 > .pin2" />

    {/* 100 nF local carrier decoupling. */}
    <trace from=".C1 > .pin1" to=".H2 > .3V3_OUT_PIN36" />
    <trace from=".C1 > .pin2" to=".H2 > .GND_PIN38" />
  </board>
)
`;
}

function generateNanoSource(req: NanoSensorDisplayTemplateRequirements): string {
  return `/*
 * Template: ${req.templateId}
 * Requirements: power=${req.powerSource}; interface=${req.interface}; connector=${req.connector};
 * environment=${req.environment}; quantity=${req.quantity}; assembly=${req.assembly};
 * target=${req.targetFab}; maximum=${req.maxWidthMm}x${req.maxHeightMm}mm; fixed board=70x45mm.
 *
 * A classic Arduino Nano-style controller is a plug-in module represented only
 * by generic female socket headers H1/H2 with unique physical-pin-suffixed labels.
 * Module USB supplies the modeled carrier 5 V rail; Nano circuitry is not modeled.
 * Firmware must configure A0 for the analog sensor, A4/A5 for I2C, D2 for the
 * pulled-up contact, and D6 for PWM/status. This starter does not prove module
 * pinout or mechanics, power budget, attached-device compatibility, ERC/DRC,
 * routing, copper, manufacturing, firmware, simulation, or physical correctness.
 */
export default () => (
  <board width="70mm" height="45mm">
    {/* Classic Nano-style plug-in module socket rows only; verify the actual module. */}
    <pinheader name="H1" pinCount={15} gender="female"
      pinLabels={${JSON.stringify(NANO_SENSOR_DISPLAY_H1_PIN_LABELS)}}
      footprint="pinrow15_p2.54" schX={-18} schY={-7} pcbX={-8} pcbY={-7.62} pcbRotation={0} />
    <pinheader name="H2" pinCount={15} gender="female"
      pinLabels={${JSON.stringify(NANO_SENSOR_DISPLAY_H2_PIN_LABELS)}}
      footprint="pinrow15_p2.54" schX={18} schY={7} pcbX={-8} pcbY={7.62} pcbRotation={0} />

    {/* Generic 2.54 mm headers; no display, sensor, switch, cable, or load is modeled. */}
    <pinheader name="J1" pinCount={4} pinLabels={["5V", "GND", "SDA", "SCL"]}
      footprint="pinrow4_p2.54" schX={42} schY={15} pcbX={30} pcbY={15} pcbRotation={90} />
    <pinheader name="J2" pinCount={3} pinLabels={["5V", "GND", "ANALOG"]}
      footprint="pinrow3_p2.54" schX={42} schY={4} pcbX={30} pcbY={4} pcbRotation={90} />
    <pinheader name="J3" pinCount={2} pinLabels={["BUTTON", "GND"]}
      footprint="pinrow2_p2.54" schX={42} schY={-5} pcbX={30} pcbY={-5} pcbRotation={90} />
    <pinheader name="J4" pinCount={2} pinLabels={["PWM", "GND"]}
      footprint="pinrow2_p2.54" schX={42} schY={-14} pcbX={30} pcbY={-14} pcbRotation={90} />

    <resistor name="R1" resistance="4.7k" footprint="0603" schX={8} schY={13} pcbX={12} pcbY={12} />
    <resistor name="R2" resistance="4.7k" footprint="0603" schX={14} schY={13} pcbX={18} pcbY={12} />
    <resistor name="R3" resistance="10k" footprint="0603" schX={14} schY={-4} pcbX={18} pcbY={-4} />
    <resistor name="R4" resistance="1k" footprint="0603" schX={8} schY={-13} pcbX={12} pcbY={-13} />
    <led name="LED1" footprint="0603" color="green" schX={15} schY={-13} pcbX={18} pcbY={-13} />
    <capacitor name="C1" capacitance="100nF" footprint="0603" schX={3} schY={16} pcbX={6} pcbY={15} />
    <capacitor name="C2" capacitance="10uF" footprint="0805" schX={-3} schY={16} pcbX={0} pcbY={15} />

    {/* 5 V I2C display header and 4.7 kOhm pull-ups on A4/A5. */}
    <trace from=".H2 > .5V_MODULE_PIN27" to=".J1 > .5V" />
    <trace from=".H2 > .GND_MODULE_PIN29" to=".J1 > .GND" />
    <trace from=".H2 > .A4_SDA_MODULE_PIN23" to=".J1 > .SDA" />
    <trace from=".H2 > .A5_SCL_MODULE_PIN24" to=".J1 > .SCL" />
    <trace from=".H2 > .5V_MODULE_PIN27" to=".R1 > .pin1" />
    <trace from=".H2 > .A4_SDA_MODULE_PIN23" to=".R1 > .pin2" />
    <trace from=".H2 > .5V_MODULE_PIN27" to=".R2 > .pin1" />
    <trace from=".H2 > .A5_SCL_MODULE_PIN24" to=".R2 > .pin2" />

    {/* Analog sensor on A0 and pulled-up dry-contact/button input on D2. */}
    <trace from=".H2 > .5V_MODULE_PIN27" to=".J2 > .5V" />
    <trace from=".H2 > .GND_MODULE_PIN29" to=".J2 > .GND" />
    <trace from=".H2 > .A0_MODULE_PIN19" to=".J2 > .ANALOG" />
    <trace from=".H1 > .D2_MODULE_PIN5" to=".J3 > .BUTTON" />
    <trace from=".H2 > .GND_MODULE_PIN29" to=".J3 > .GND" />
    <trace from=".H2 > .5V_MODULE_PIN27" to=".R3 > .pin1" />
    <trace from=".H1 > .D2_MODULE_PIN5" to=".R3 > .pin2" />

    {/* Current-limited local LED and mirrored logic-level PWM/GND header on D6. */}
    <trace from=".H1 > .D6_PWM_MODULE_PIN9" to=".R4 > .pin1" />
    <trace from=".R4 > .pin2" to=".LED1 > .anode" />
    <trace from=".H2 > .GND_MODULE_PIN29" to=".LED1 > .cathode" />
    <trace from=".H1 > .D6_PWM_MODULE_PIN9" to=".J4 > .PWM" />
    <trace from=".H2 > .GND_MODULE_PIN29" to=".J4 > .GND" />

    {/* Local carrier bypass and bulk capacitance across the 5 V/GND rails. */}
    <trace from=".C1 > .pin1" to=".H2 > .5V_MODULE_PIN27" />
    <trace from=".C1 > .pin2" to=".H2 > .GND_MODULE_PIN29" />
    <trace from=".C2 > .pin1" to=".H2 > .5V_MODULE_PIN27" />
    <trace from=".C2 > .pin2" to=".H2 > .GND_MODULE_PIN29" />
  </board>
)
`;
}

export function verifyProjectTemplateProjection(source: string, elements: AnyCircuitElement[]): ProjectTemplatePreviewMetadata {
  const extracted = extractRequirementsFromHeader(source);
  const requirements = validateProjectTemplateRequirements(extracted);
  switch (requirements.templateId) {
    case XIAO_I2C_TEMPLATE_ID:
      return verifyProjection(source, elements, requirements, XIAO_I2C_EXPECTED_REFS, XIAO_I2C_EXPECTED_TRACE_COUNT, XIAO_I2C_EXPECTED_CONNECTIONS);
    case PICO_SENSOR_STATUS_TEMPLATE_ID:
      return verifyProjection(source, elements, requirements, PICO_SENSOR_STATUS_EXPECTED_REFS, PICO_SENSOR_STATUS_EXPECTED_TRACE_COUNT, PICO_SENSOR_STATUS_EXPECTED_CONNECTIONS);
    case NANO_SENSOR_DISPLAY_TEMPLATE_ID:
      return verifyProjection(source, elements, requirements, NANO_SENSOR_DISPLAY_EXPECTED_REFS, NANO_SENSOR_DISPLAY_EXPECTED_TRACE_COUNT, NANO_SENSOR_DISPLAY_EXPECTED_CONNECTIONS);
  }
}

function verifyProjection(
  source: string,
  elements: AnyCircuitElement[],
  requirements: ProjectTemplateRequirements,
  expectedRefs: readonly string[],
  expectedTraceCount: number,
  expectedConnections: readonly string[],
): ProjectTemplatePreviewMetadata {
  const template = getProjectTemplate(requirements.templateId);
  const names = listComponents(elements).map((component) => component.name).sort();
  const expected = [...expectedRefs].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Template evaluation produced refs [${names.join(', ')}], expected [${expected.join(', ')}].`);
  const boards = elements.filter((element) => element.type === 'pcb_board') as Array<Record<string, unknown>>;
  if (boards.length !== 1 || boards[0].width !== template.board.widthMm || boards[0].height !== template.board.heightMm || boards[0].num_layers !== 2) {
    throw new Error(`Template evaluation did not produce exactly one ${template.board.widthMm} × ${template.board.heightMm} mm, two-layer PCB board.`);
  }
  const evaluatedErrors = elements.filter((element) => element.type.includes('error'));
  if (evaluatedErrors.length) {
    const types = [...new Set(evaluatedErrors.map((element) => element.type))].sort();
    throw new Error(`Template evaluation produced ${evaluatedErrors.length} error element(s): ${types.join(', ')}.`);
  }
  const traces = elements.filter((element) => element.type === 'source_trace');
  if (traces.length !== expectedTraceCount) throw new Error(`Template evaluation produced ${traces.length} source traces; expected ${expectedTraceCount}.`);
  const { portNames, portsByComponent } = sourcePortMaps(elements);
  const connections = traces.map((trace) => {
    const ids = Array.isArray(trace.connected_source_port_ids) ? trace.connected_source_port_ids : [];
    return ids.map((id) => portNames.get(String(id)) ?? '(unresolved)').sort((left, right) => left.localeCompare(right)).join(' <-> ');
  }).sort();
  if (JSON.stringify(connections) !== JSON.stringify([...expectedConnections].sort())) {
    throw new Error(`Template evaluation produced unexpected source connections: ${connections.join('; ')}.`);
  }
  if (requirements.templateId === PICO_SENSOR_STATUS_TEMPLATE_ID) verifyPicoProjection(source, elements, portsByComponent);
  else if (requirements.templateId === NANO_SENSOR_DISPLAY_TEMPLATE_ID) verifyNanoProjection(source, elements, portsByComponent);
  else verifyRequiredSourceFacts(source, ['pinCount={7}', 'pinCount={4}', 'resistance="4.7k"', 'resistance="1k"', 'resistance="10k"', 'capacitance="100nF"', 'width="40mm"', 'height="30mm"']);
  return {
    templateId: requirements.templateId,
    requirements,
    expectedRefs: [...expectedRefs],
    board: { ...template.board, layers: 2 },
    limitations: [...template.limitations],
  };
}

function verifyPicoProjection(source: string, elements: AnyCircuitElement[], portsByComponent: Map<string, string[]>): void {
  const h1 = portsByComponent.get('H1') ?? [];
  const h2 = portsByComponent.get('H2') ?? [];
  if (JSON.stringify(h1) !== JSON.stringify([...PICO_SENSOR_STATUS_H1_PIN_LABELS])) throw new Error('Pico H1 source ports do not match the exact unique physical-pin-suffixed labels.');
  if (JSON.stringify(h2) !== JSON.stringify([...PICO_SENSOR_STATUS_H2_PIN_LABELS])) throw new Error('Pico H2 source ports do not match the exact unique physical-pin-suffixed labels.');
  const allModulePins = [...h1, ...h2];
  if (new Set(allModulePins).size !== allModulePins.length) throw new Error('Pico socket source-port labels must be globally unique.');
  for (const port of PICO_SENSOR_STATUS_REQUIRED_SOURCE_PORTS) {
    const [ref, pin] = port.split('.');
    if (!(portsByComponent.get(ref) ?? []).includes(pin)) throw new Error(`Pico template is missing required exact source port ${port}.`);
  }
  const sourceNames = new Map(elements.filter((element) => element.type === 'source_component').map((element) => [String(element.source_component_id), String(element.name)]));
  const observed = new Map(elements.filter((element) => element.type === 'pcb_component').map((element) => {
    const center = isRecord(element.center) ? element.center : {};
    return [sourceNames.get(String(element.source_component_id)), { x: center.x, y: center.y, rotation: element.rotation }];
  }));
  for (const [ref, expected] of Object.entries(PICO_SENSOR_STATUS_EXPECTED_GEOMETRY)) {
    const actual = observed.get(ref);
    if (!actual || !nearlyEqual(actual.x, expected.x) || !nearlyEqual(actual.y, expected.y) || !nearlyEqual(actual.rotation, expected.rotation)) {
      throw new Error(`Pico template geometry for ${ref} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`);
    }
  }
  const components = new Map(elements.filter((element) => element.type === 'source_component').map((element) => [String(element.name), element]));
  for (const [ref, value] of [['R1', 4700], ['R2', 1000], ['R3', 10000], ['C1', 1e-7]] as const) {
    const component = components.get(ref);
    const observedValue = ref === 'C1' ? component?.capacitance : component?.resistance;
    if (observedValue !== value) throw new Error(`Pico template value for ${ref} was ${String(observedValue)}, expected ${value}.`);
  }
  const footprints = new Map(elements.filter((element) => element.type === 'cad_component').map((element) => [
    sourceNames.get(String(element.source_component_id)), String(element.footprinter_string),
  ]));
  for (const [ref, expected] of Object.entries(PICO_SENSOR_STATUS_EXPECTED_FOOTPRINTS)) {
    if (footprints.get(ref) !== expected) throw new Error(`Pico template evaluated footprint for ${ref} was ${String(footprints.get(ref))}, expected ${expected}.`);
  }
  verifyRequiredSourceFacts(source, [
    'pinCount={20}', 'pinCount={3}', 'pinCount={2}', 'gender="female"', 'resistance="4.7k"',
    'resistance="1k"', 'resistance="10k"', 'capacitance="100nF"', 'width="75mm"', 'height="45mm"',
  ]);
}

function verifyNanoProjection(source: string, elements: AnyCircuitElement[], portsByComponent: Map<string, string[]>): void {
  const h1 = portsByComponent.get('H1') ?? [];
  const h2 = portsByComponent.get('H2') ?? [];
  if (JSON.stringify(h1) !== JSON.stringify([...NANO_SENSOR_DISPLAY_H1_PIN_LABELS])) throw new Error('Nano H1 source ports do not match the exact unique physical-pin-suffixed labels.');
  if (JSON.stringify(h2) !== JSON.stringify([...NANO_SENSOR_DISPLAY_H2_PIN_LABELS])) throw new Error('Nano H2 source ports do not match the exact unique physical-pin-suffixed labels.');
  const allModulePins = [...h1, ...h2];
  if (new Set(allModulePins).size !== allModulePins.length) throw new Error('Nano socket source-port labels must be globally unique.');
  for (const port of NANO_SENSOR_DISPLAY_REQUIRED_SOURCE_PORTS) {
    const [ref, pin] = port.split('.');
    if (!(portsByComponent.get(ref) ?? []).includes(pin)) throw new Error(`Nano template is missing required exact source port ${port}.`);
  }
  const sourceNames = new Map(elements.filter((element) => element.type === 'source_component').map((element) => [String(element.source_component_id), String(element.name)]));
  const observed = new Map(elements.filter((element) => element.type === 'pcb_component').map((element) => {
    const center = isRecord(element.center) ? element.center : {};
    return [sourceNames.get(String(element.source_component_id)), { x: center.x, y: center.y, rotation: element.rotation }];
  }));
  for (const [ref, expected] of Object.entries(NANO_SENSOR_DISPLAY_EXPECTED_GEOMETRY)) {
    const actual = observed.get(ref);
    if (!actual || !nearlyEqual(actual.x, expected.x) || !nearlyEqual(actual.y, expected.y) || !nearlyEqual(actual.rotation, expected.rotation)) {
      throw new Error(`Nano template geometry for ${ref} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`);
    }
  }
  const components = new Map(elements.filter((element) => element.type === 'source_component').map((element) => [String(element.name), element]));
  for (const [ref, value] of [['R1', 4700], ['R2', 4700], ['R3', 10000], ['R4', 1000], ['C1', 1e-7], ['C2', 1e-5]] as const) {
    const component = components.get(ref);
    const observedValue = ref === 'C1' || ref === 'C2' ? component?.capacitance : component?.resistance;
    if (observedValue !== value) throw new Error(`Nano template value for ${ref} was ${String(observedValue)}, expected ${value}.`);
  }
  const footprints = new Map(elements.filter((element) => element.type === 'cad_component').map((element) => [
    sourceNames.get(String(element.source_component_id)), String(element.footprinter_string),
  ]));
  for (const [ref, expected] of Object.entries(NANO_SENSOR_DISPLAY_EXPECTED_FOOTPRINTS)) {
    if (footprints.get(ref) !== expected) throw new Error(`Nano template evaluated footprint for ${ref} was ${String(footprints.get(ref))}, expected ${expected}.`);
  }
  verifyRequiredSourceFacts(source, [
    'pinCount={15}', 'pinCount={4}', 'pinCount={3}', 'pinCount={2}', 'gender="female"',
    'resistance="4.7k"', 'resistance="1k"', 'resistance="10k"',
    'capacitance="100nF"', 'capacitance="10uF"', 'width="70mm"', 'height="45mm"',
  ]);
}

function sourcePortMaps(elements: AnyCircuitElement[]): { portNames: Map<string, string>; portsByComponent: Map<string, string[]> } {
  const componentNames = new Map(elements.filter((element) => element.type === 'source_component').map((element) => [String(element.source_component_id), String(element.name)]));
  const portNames = new Map<string, string>();
  const portsByComponent = new Map<string, Array<{ number: number; name: string }>>();
  for (const element of elements.filter((candidate) => candidate.type === 'source_port')) {
    const ref = componentNames.get(String(element.source_component_id)) ?? '(unresolved)';
    const name = String(element.name);
    portNames.set(String(element.source_port_id), `${ref}.${name}`);
    const list = portsByComponent.get(ref) ?? [];
    list.push({ number: Number(element.pin_number), name });
    portsByComponent.set(ref, list);
  }
  return {
    portNames,
    portsByComponent: new Map([...portsByComponent].map(([ref, ports]) => [ref, ports.sort((a, b) => a.number - b.number).map((port) => port.name)])),
  };
}

function verifyRequiredSourceFacts(source: string, facts: readonly string[]): void {
  for (const fact of facts) if (!source.includes(fact)) throw new Error(`Generated source is missing required fact ${fact}.`);
  if (!source.match(/Requirements: power=[\s\S]*maximum=([\d.]+)x([\d.]+)mm/)) throw new Error('Generated source does not echo the normalized requirements.');
}

function extractRequirementsFromHeader(source: string): Record<string, unknown> {
  const read = (pattern: RegExp, field: string) => {
    const match = source.match(pattern)?.[1];
    if (!match) throw new Error(`Generated source does not echo ${field}.`);
    return match;
  };
  return {
    templateId: read(/Template: ([^\s]+)/, 'templateId'),
    powerSource: read(/Requirements: power=([^;]+);/, 'powerSource'),
    interface: read(/interface=([^;]+);/, 'interface'),
    connector: read(/connector=([^;]+);/, 'connector'),
    environment: read(/environment=([^;]+);/, 'environment'),
    quantity: Number(read(/quantity=([^;]+);/, 'quantity')),
    assembly: read(/assembly=([^;]+);/, 'assembly'),
    targetFab: read(/target=([^;]+);/, 'targetFab'),
    maxWidthMm: Number(read(/maximum=([\d.]+)x/, 'maxWidthMm')),
    maxHeightMm: Number(read(/maximum=[\d.]+x([\d.]+)mm/, 'maxHeightMm')),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: unknown, field: string, expected: string): void {
  if (value !== expected) throw new Error(`${field} must be exactly "${expected}" for the selected template.`);
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

function nearlyEqual(value: unknown, expected: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected) <= 1e-9;
}
