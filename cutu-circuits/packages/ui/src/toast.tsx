import {Toaster} from "sonner";
import Icon from "@cutucircuits/ui/icon";

export interface ToastStackProps {
  readonly theme: "dark" | "light";
}

/** Shared notification presentation. The application owns senders and chat routing. */
export default function ToastStack({theme}: ToastStackProps) {
  return (
    <Toaster
      className="cutucircuits-toaster"
      position="top-center"
      theme={theme}
      closeButton
      visibleToasts={3}
      offset={{top: 56, left: 16, right: 16}}
      mobileOffset={{top: 56, left: 12, right: 12}}
      gap={10}
      hotkey={["altKey", "KeyT"]}
      icons={{
        success: <Icon name="check" size="sm" />,
        info: <Icon name="circle-alert" size="sm" />,
        warning: <Icon name="alert-triangle" size="sm" />,
        error: <Icon name="circle-alert" size="sm" />,
        loading: <Icon name="loader" size="sm" className="cutucircuits-toast-spinner" />,
        close: <Icon name="x" size="xs" />,
      }}
      toastOptions={{closeButtonAriaLabel: "Dismiss notification"}}
    />
  );
}
