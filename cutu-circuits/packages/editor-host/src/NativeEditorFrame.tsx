import { useEffect, useReducer, useRef, type ReactNode } from "react";
import Button from "@cutucircuits/ui/button";
import Menu, { MenuItem } from "@cutucircuits/ui/menu";
import type { BrowserHost } from "./browser";
export function NativeEditorFrame({
  host,
  children,
}: {
  host: BrowserHost;
  children: ReactNode;
}) {
  const [, update] = useReducer((n) => n + 1, 0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = host.subscribe(update);
    update();
    return off;
  }, [host]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void host.requestSave().catch(() => {});
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (host.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("keydown", save);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("keydown", save);
      window.removeEventListener("beforeunload", unload);
      window.dispatchEvent(
        new CustomEvent("cutucircuits:dirty", {
          detail: {
            dirty: false,
            projectId: host.workspaceId,
            path: host.filePath,
          },
        }),
      );
    };
  }, [host]);
  return (
    <div className="cutucircuits-native-editor-frame" ref={ref}>
      <div
        className="cutucircuits-native-editor-actions"
        data-dirty={host.dirty}
      >
        {(host.dirty || host.saving) && (
          <>
            <span role="status">
              {host.saving ? "Saving…" : "Unsaved changes"}
            </span>
            <Button
              variant="filled"
              size="sm"
              style={{ width: "auto" }}
              disabled={host.saving}
              onClick={() => void host.requestSave().catch(() => {})}
            >
              Save
            </Button>
          </>
        )}
        {!!host.menuItems.length && (
          <Menu
            triggerLabel="Document actions"
            trigger={(props) => (
              <Button {...props} variant="ghost" size="sm">
                •••
              </Button>
            )}
          >
            {host.menuItems.map((item, index) => (
              <MenuItem key={index} onClick={() => item.onClick()}>
                {item.label}
              </MenuItem>
            ))}
          </Menu>
        )}
      </div>
      {host.saveError && (
        <div role="alert" className="cutucircuits-native-editor-save-error">
          {host.saveError} Your edits are still open.{" "}
          <Button
            size="sm"
            style={{ width: "auto" }}
            onClick={() => void host.requestSave().catch(() => {})}
          >
            Retry save
          </Button>
        </div>
      )}
      <div className="cutucircuits-native-editor-content">{children}</div>
    </div>
  );
}
