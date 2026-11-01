import type {ComponentProps, ReactNode} from "react";
import {cn} from "@cutucircuits/ui/cn";

export interface ComposerSurfaceProps extends ComponentProps<"div"> {
  readonly toolbar: ReactNode;
  readonly project?: ReactNode;
}

/** Presentation shell for an editor and toolbar supplied by the consumer. */
export function ComposerSurface({children, toolbar, project, className, ...props}: ComposerSurfaceProps) {
  return (
    <div className={cn("cutucircuits-composer-stack w-full", className)} {...props}>
      {project && <div className="cutucircuits-project-rail">{project}</div>}
      <div className="cutucircuits-composer relative border border-border-muted bg-surface-control">
        {children}
        <div className="cutucircuits-composer-toolbar flex items-center">{toolbar}</div>
      </div>
    </div>
  );
}

/** Rounded message surface; content and delivery are owned by the consumer. */
export function MessageBubble({className, ...props}: ComponentProps<"div">) {
  return <div className={cn("cutucircuits-message-bubble bg-surface-raised text-ink", className)} {...props} />;
}

/** Compact sidebar row with the shared hover and selection treatment. */
export function SidebarRow({className, ...props}: ComponentProps<"button">) {
  return <button type="button" className={cn("cutucircuits-chat-row flex w-full items-center gap-2 text-left text-sm text-ink-muted hover:bg-overlay-hover aria-current:bg-overlay-pressed aria-current:text-ink", className)} {...props} />;
}
