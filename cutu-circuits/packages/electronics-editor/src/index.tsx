/**
 * Electronics Studio Extension
 *
 * A CutuCircuits extension that takes a maker through the controller/PCB loop:
 * design -> simulate -> test -> manufacture-export. This first release lands the
 * hybrid design surface (tscircuit code + parts palette + live schematic/PCB
 * render) and the agent tools that operate it; simulation and direct fab
 * ordering are layered in by later phases.
 *
 * Engine: tscircuit (React-native, in-browser) with Circuit JSON as the on-disk,
 * version-controllable, AI-mutable source of truth.
 */

import './styles.css';
import { ElectronicsEditor } from './components/ElectronicsEditor';
import { aiTools } from './aiTools';
import { agentAIServiceBridge } from './agentSession';
import type { ExtensionContext } from '@cutucircuits/editor-host';

let disposeAIService: (() => void) | undefined;

export async function activate(context: ExtensionContext) {
  console.log('[ElectronicsStudio] Extension activated');
  disposeAIService?.();
  disposeAIService = context.services.ai
    ? agentAIServiceBridge.install(context.services.ai)
    : undefined;
}

export async function deactivate() {
  disposeAIService?.();
  disposeAIService = undefined;
  console.log('[ElectronicsStudio] Extension deactivated');
}

/** Components referenced by manifest.json contributions.customEditors. */
export const components = {
  ElectronicsEditor,
};

/** AI tools referenced by manifest.json contributions.aiTools. */
export { aiTools };
