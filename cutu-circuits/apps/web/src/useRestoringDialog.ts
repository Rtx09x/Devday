import { useCallback, useRef, useState, type SetStateAction } from "react";

/** Imperatively opened Myui dialogs restore focus once their close motion finishes. */
export function useRestoringDialog(fallbackSelector: string) {
  const [open, setState] = useState(false);
  const isOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const setOpen = useCallback((next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(isOpen.current) : next;
    if (value && !isOpen.current) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    isOpen.current = value;
    setState(value);
  }, []);
  const onOpenChangeComplete = useCallback(
    (value: boolean) => {
      if (value || isOpen.current) return;
      const previous = opener.current;
      const target =
        previous?.isConnected && previous !== document.body
          ? previous
          : document.querySelector<HTMLElement>(fallbackSelector);
      target?.focus({ preventScroll: true });
      opener.current = null;
    },
    [fallbackSelector],
  );
  return [open, setOpen, onOpenChangeComplete] as const;
}
