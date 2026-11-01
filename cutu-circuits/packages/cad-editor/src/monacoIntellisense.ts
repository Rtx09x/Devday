// Vendored from replicad 0.23.1: its declaration subpath is not exported.
// Keeping the raw declaration local works with hoisted workspace dependencies.
import replicadDts from '../assets/replicad.d.ts?raw';
import { REPLICAD_MODEL_CONTRACT_DTS, wrapDtsAsAmbientModule } from './replicadDts';

interface MonacoTypeScriptDefaults {
  addExtraLib(content: string, filePath?: string): { dispose(): void };
}

interface MonacoNamespace {
  languages?: {
    typescript?: {
      typescriptDefaults?: MonacoTypeScriptDefaults;
    };
  };
}

const REPLICAD_LIB_PATH = 'file:///cutucircuits/replicad/replicad.d.ts';
const MODEL_CONTRACT_LIB_PATH = 'file:///cutucircuits/replicad/model-contract.d.ts';
let registered = false;

/** Adds Replicad authoring types to the host's shared Monaco TS worker once. */
export function registerReplicadIntellisense(monaco: MonacoNamespace | undefined): boolean {
  if (registered) return true;

  const defaults = monaco?.languages?.typescript?.typescriptDefaults;
  if (!defaults?.addExtraLib) return false;

  defaults.addExtraLib(wrapDtsAsAmbientModule(replicadDts, 'replicad'), REPLICAD_LIB_PATH);
  defaults.addExtraLib(REPLICAD_MODEL_CONTRACT_DTS, MODEL_CONTRACT_LIB_PATH);
  registered = true;
  return true;
}
