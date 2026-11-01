import {useMemo,useEffect} from 'react';
import {BrowserHost,NativeEditorFrame,type EngineEditorProps,type ExtensionAITool} from '@cutucircuits/editor-host';
import {createReplicadProjectEditor} from './ReplicadProjectEditor';
import {createAiTools} from './aiTools';
import './styles.css';
export {createReplicadProjectEditor,createAiTools};
export default function EngineEditor(props:EngineEditorProps){const host=useMemo(()=>new BrowserHost(props),[props.project.id,props.asset.path]);const Editor=useMemo(()=>createReplicadProjectEditor(host.context),[host]);const tools=useMemo(()=>createAiTools(host.context),[host]);useEffect(()=>host.connect(tools as unknown as ExtensionAITool[]),[host,tools]);return <NativeEditorFrame host={host}><Editor host={host}/></NativeEditorFrame>}
