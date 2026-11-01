import { useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { EditorHost } from "./types";
(globalThis as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
export interface MonacoEditorProps {
  host: EditorHost;
  fileName: string;
  config?: { theme?: unknown; extensionThemeId?: string; isActive?: boolean };
  onEditorReady?: (editor: any) => void;
  onGetContent?: (get: () => string) => void;
  onDiffChangeCountUpdate?: (count: number) => void;
}
export function MonacoEditor({
  host,
  fileName,
  onEditorReady,
  onGetContent,
}: MonacoEditorProps) {
  const [editorMode, setEditorMode] = useState(host.theme);
  useEffect(() => host.onThemeChanged(setEditorMode), [host]);
  const [value, setValue] = useState<string>();
  const [error, setError] = useState("");
  const current = useRef("");
  const modified = useRef(false);
  const editVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void host
      .loadContent()
      .then((c) => {
        if (alive) {
          current.current = c;
          setValue(c);
        }
      })
      .catch((e) => setError(e.message));
    const off = host.onFileChanged((c) => {
      if (!modified.current) {
        current.current = c;
        setValue(c);
      }
    });
    const save = async () => {
      if (timer.current) clearTimeout(timer.current);
      const version = editVersion.current;
      try {
        await host.saveContent(current.current);
        if (version === editVersion.current) modified.current = false;
        if (alive) setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    const offSave = host.onSaveRequested(() => void save());
    (current as any).save = save;
    return () => {
      alive = false;
      off();
      offSave();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [host]);
  if (error && value === undefined)
    return (
      <div role="alert" style={{ padding: 12 }}>
        {error}
        <button onClick={() => void (current as any).save?.()}>
          Retry save
        </button>
      </div>
    );
  if (value === undefined) return <div>Loading source…</div>;
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {error && (
        <div role="alert" style={{ padding: "8px 12px", fontSize: 13 }}>
          {error} Your source remains editable below.
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          path={host.filePath}
          language={
            fileName.endsWith(".json")
              ? "json"
              : fileName.endsWith(".tsx")
                ? "typescript"
                : "typescript"
          }
          theme={editorMode === "dark" ? "vs-dark" : "light"}
          value={value}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
          }}
          onMount={(editor) => {
            onGetContent?.(() => editor.getValue());
            onEditorReady?.({ editor, monaco });
          }}
          onChange={(v) => {
            current.current = v ?? "";
            setValue(current.current);
            modified.current = true;
            editVersion.current++;
            host.setDirty(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(
              () => void (current as any).save?.(),
              650,
            );
          }}
        />
      </div>
    </div>
  );
}
