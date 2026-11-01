import './styles.css';
import type { ExtensionAITool, ExtensionContext } from '@cutucircuits/editor-host';
import type { ComponentType } from 'react';
import { createReplicadProjectEditor } from './ReplicadProjectEditor';
import { MeshAssetEditor } from './MeshAssetEditor';
import { createAiTools } from './aiTools';
import { disposeReplicadWorker } from './runtime/client';

// The loader captures the references of `components` and `aiTools` once at
// module-load time. We populate them in activate() with closures that hold the
// ExtensionContext so the editor and tools can reach filesystem, configuration,
// and the extension's own bundled-asset directory (worker + wasm).
export const components: Record<string, ComponentType<unknown>> = {};
export const aiTools: ExtensionAITool[] = [];

export async function activate(context: ExtensionContext): Promise<void> {
  components.ReplicadProjectEditor = createReplicadProjectEditor(context) as ComponentType<unknown>;
  components.MeshAssetEditor = MeshAssetEditor as ComponentType<unknown>;
  aiTools.length = 0;
  aiTools.push(...(createAiTools(context) as unknown as ExtensionAITool[]));
}

export async function deactivate(): Promise<void> {
  // Terminate the kernel worker — its Blob URL and the decoded OCCT wasm leak otherwise.
  disposeReplicadWorker();
  for (const key of Object.keys(components)) delete components[key];
  aiTools.length = 0;
}
