import {useMemo,useEffect} from 'react';
import {BrowserHost,NativeEditorFrame,type EngineEditorProps} from '@cutucircuits/editor-host';
import {ElectronicsEditor} from './components/ElectronicsEditor';
import {aiTools} from './aiTools';
import './styles.css';
export {ElectronicsEditor,aiTools};
export default function EngineEditor(props:EngineEditorProps){const host=useMemo(()=>new BrowserHost(props),[props.project.id,props.asset.path]);useEffect(()=>host.connect(aiTools),[host]);return <NativeEditorFrame host={host}><ElectronicsEditor host={host}/></NativeEditorFrame>}
