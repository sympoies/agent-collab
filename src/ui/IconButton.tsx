// An icon-only button. It fixes the geometry (square, centered glyph; a larger hit area on touch)
// and requires a name: the accessible name and the tooltip are the same catalog text. Everything
// else is a native button, so state attributes such as aria-pressed pass straight through.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title" | "aria-label"
> {
  /** The accessible name and the tooltip. */
  readonly label: string;
  readonly children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={className === undefined ? "icon-button" : `icon-button ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
});
