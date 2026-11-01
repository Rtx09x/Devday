import type {ComponentProps} from "react";
import Icon from "@cutucircuits/ui/icon";
import {cn} from "@cutucircuits/ui/cn";

export function Breadcrumb(props: ComponentProps<"nav">) {
  return <nav aria-label="Breadcrumb" {...props} />;
}

export function BreadcrumbList(props: ComponentProps<"ol">) {
  const {className, ...rest} = props;
  return <ol className={cn("flex min-w-0 items-center gap-2 text-sm text-ink-muted", className)} {...rest} />;
}

export function BreadcrumbItem(props: ComponentProps<"li">) {
  const {className, ...rest} = props;
  return <li className={cn("inline-flex min-w-0 items-center gap-2", className)} {...rest} />;
}

/** Accepts the application's router Link as its child. */
export function BreadcrumbLink(props: ComponentProps<"span">) {
  const {className, ...rest} = props;
  return (
    <span
      className={cn(
        "[&_a]:rounded-md [&_a]:transition-colors [&_a]:hover:text-ink [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-4 [&_a]:focus-visible:outline-ink-muted",
        className
      )}
      {...rest}
    />
  );
}

export function BreadcrumbPage(props: ComponentProps<"span">) {
  const {className, ...rest} = props;
  return <span aria-current="page" className={cn("truncate text-ink", className)} {...rest} />;
}

export function BreadcrumbSeparator() {
  return (
    <li role="presentation" aria-hidden="true" className="text-ink-faint">
      <Icon name="chevron-right" size="xs" />
    </li>
  );
}
