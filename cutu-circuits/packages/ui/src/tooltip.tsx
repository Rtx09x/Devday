import {Tooltip as BaseTooltip} from "@base-ui/react/tooltip";
import type {ReactElement, ReactNode} from "react";

export interface TooltipProps {
  readonly children: ReactElement;
  readonly content: ReactNode;
}

/** Quiet hover/focus help using the same material as menus. */
export default function Tooltip({children, content}: TooltipProps) {
  return (
    <BaseTooltip.Provider delay={400}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side="top" sideOffset={8} className="z-50">
            <BaseTooltip.Popup className="cutucircuits-tooltip">{content}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
