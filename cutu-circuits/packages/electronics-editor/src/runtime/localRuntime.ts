/** Inspectable contract for which Electronics Studio paths are local or optional. */

export interface RuntimeCapability {
  id: string;
  label: string;
  mode: 'bundled' | 'local-toolchain' | 'optional-network';
  detail: string;
}

export const LOCAL_RUNTIME_CONTRACT: RuntimeCapability[] = [
  {
    id: 'design-evaluation',
    label: 'Design evaluation',
    mode: 'bundled',
    detail: 'The pinned tscircuit worker is bundled with the extension; package imports from remote registries are disabled.',
  },
  {
    id: 'simulation',
    label: 'Logical and analog simulation',
    mode: 'bundled',
    detail: 'Logical models, ngspice WASM, AVR, and RP2040 emulation run from bundled JavaScript/WASM assets.',
  },
  {
    id: 'firmware-toolchains',
    label: 'Firmware builds and ESP32 emulation',
    mode: 'local-toolchain',
    detail: 'Optional arduino-cli, PlatformIO, and QEMU executables are detected locally and are never installed automatically.',
  },
  {
    id: 'agent-provider',
    label: 'Coding agent',
    mode: 'optional-network',
    detail: 'The configured CutuCircuits agent may use a hosted model; its network and data handling follow that provider configuration.',
  },
  {
    id: 'live-supplier-data',
    label: 'Supplier data and quotes',
    mode: 'optional-network',
    detail: 'Live inventory, pricing, datasheets, and fab quotes are not required for design, simulation, or deterministic exports.',
  },
];

export function runtimeContractSummary(): { offlineCore: boolean; capabilities: RuntimeCapability[] } {
  return {
    offlineCore: LOCAL_RUNTIME_CONTRACT
      .filter((capability) => capability.id === 'design-evaluation' || capability.id === 'simulation')
      .every((capability) => capability.mode === 'bundled'),
    capabilities: LOCAL_RUNTIME_CONTRACT,
  };
}
