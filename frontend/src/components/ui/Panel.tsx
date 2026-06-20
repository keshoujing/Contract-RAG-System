import clsx from "clsx";
import { forwardRef } from "react";
import { CircleX } from "lucide-react";
import { Button } from "./Button";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

export const Card = forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { children: React.ReactNode }>(
  function Card({ children, className, ...props }, ref) {
    return <section ref={ref} className={clsx("card", className)} {...props}>{children}</section>;
  }
);

export function EmptyState({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">∅</div>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function ErrorState({ text, onRetry, retrying = false }: { text: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div className="empty-state error-state">
      <div className="empty-icon error-icon"><CircleX size={22} /></div>
      <p>{text}</p>
      <Button onClick={onRetry} loading={retrying}>重试</Button>
    </div>
  );
}
