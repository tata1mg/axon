import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { RichText } from "./RichText.tsx";

interface StatePanelProps {
  readonly icon?: IconName;
  readonly tone?: "accent" | "danger";
  readonly title?: string;
  readonly message?: string;
  /** Backtick-delimited secondary text. */
  readonly hint?: string;
  readonly compact?: boolean;
  readonly children?: ReactNode;
}

/** Centered empty, error, and expired-session states. */
export function StatePanel({
  icon,
  tone = "accent",
  title,
  message,
  hint,
  compact,
  children,
}: StatePanelProps) {
  return (
    <section className={compact ? "state-panel compact" : "state-panel"}>
      {icon && (
        <span className={tone === "danger" ? "state-icon danger" : "state-icon"}>
          <Icon name={icon} />
        </span>
      )}
      {title && <h2>{title}</h2>}
      {message && <p>{message}</p>}
      {hint && (
        <p className="state-hint">
          <RichText text={hint} />
        </p>
      )}
      {children}
    </section>
  );
}
