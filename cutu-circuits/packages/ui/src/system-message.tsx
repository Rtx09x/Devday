import type {ComponentProps} from "react";
import Icon from "@cutucircuits/ui/icon";
import {cn} from "@cutucircuits/ui/cn";

export interface SystemMessageProps extends ComponentProps<"div"> {
  readonly variant?: "info" | "error";
}

/** Compact contextual notice, following prompt-kit's SystemMessage layout with our theme and icons. */
export default function SystemMessage(props: SystemMessageProps) {
  const {children, className, variant = "info", ...attributes} = props;
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      {...attributes}
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-sm leading-5",
        variant === "error" ? "border-danger-ink/25 bg-danger-ink/5 text-danger-ink" : "border-border-muted bg-surface-raised text-ink-muted",
        className
      )}
    >
      <span className="flex h-5 shrink-0 items-center">
        <Icon name={variant === "error" ? "circle-alert" : "info"} size="sm" />
      </span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}
