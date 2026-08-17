import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "regular";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: IconName;
}

export interface IconButtonProps
  extends Omit<ButtonProps, "children" | "leadingIcon"> {
  icon: IconName;
  label: string;
}

function joinClasses(parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function renderLeadingIcon(icon: IconName | undefined): ReactNode {
  if (!icon) return null;
  return <Icon name={icon} size={16} />;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "regular",
    loading = false,
    leadingIcon,
    type = "button",
    disabled,
    className = "",
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={joinClasses([
        "ui-button",
        size === "small" && "ui-button--small",
        variant !== "secondary" && `ui-button--${variant}`,
        className,
      ])}
    >
      {renderLeadingIcon(leadingIcon)}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { icon, label, className = "", children: _children, ...props },
    ref,
  ) {
    return (
      <Button
        {...props}
        ref={ref}
        className={joinClasses(["ui-icon-button", className])}
        aria-label={label}
        title={label}
      >
        <Icon name={icon} size={16} />
      </Button>
    );
  },
);
