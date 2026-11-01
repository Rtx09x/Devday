import type {ComponentProps} from "react";
import icons from "./icons/data.json";

import {cn} from "@cutucircuits/ui/cn";

export type IconName = keyof typeof icons;
export const iconNames = Object.keys(icons) as readonly IconName[];

/** Checks a saved icon choice against the one shipped catalogue. */
export function isIconName(value: string): value is IconName {
  return Object.hasOwn(icons, value);
}

const sizeClasses: Record<NonNullable<IconProps["size"]>, string> = {
  xs: "size-3.5",
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
};

export interface IconProps extends Omit<ComponentProps<"svg">, "children" | "name"> {
  readonly name: IconName;
  readonly size?: "lg" | "md" | "sm" | "xs";
}

export default function Icon(props: IconProps) {
  const {className, name, size = "md", ...iconProps} = props;
  const icon = icons[name];

  return (
    <svg
      aria-hidden="true"
      className={cn(sizeClasses[size], "shrink-0", className)}
      data-name={name}
      fill="none"
      focusable="false"
      viewBox={icon.viewBox}
      {...iconProps}
      dangerouslySetInnerHTML={{__html: icon.body}}
    />
  );
}
