import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", loading = false, icon, children, className, disabled, ...props }: ButtonProps) {
  return (
    <button className={clsx("button", `button-${variant}`, className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="spin" size={16} /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
