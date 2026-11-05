import type { ReactNode } from "react";

import { useT } from "../../i18n/LocaleProvider";
import { personSlot, type People } from "../people";

function withClass(base: string, additional: string | undefined): string {
  return additional === undefined ? base : [base, additional].join(" ");
}

function initials(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** A participant label using the same theme-aware palette slot as chat. */
export function ParticipantIdentity({
  name,
  people,
  avatar = false,
  title,
  ariaLabel,
  className,
  labelClassName,
}: {
  readonly name: string;
  readonly people: People;
  readonly avatar?: boolean;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly labelClassName?: string;
}) {
  return (
    <span
      className={withClass("shared-participant", className)}
      title={title}
      aria-label={ariaLabel}
      {...personSlot(people.slot(name))}
    >
      {avatar && (
        <span className="shared-avatar avatar" aria-hidden="true">
          {initials(name)}
        </span>
      )}
      <span className={labelClassName} title={title}>
        {people.label(name)}
      </span>
    </span>
  );
}

/** The topic-list label reused on cards, references, and message metadata. */
export function TopicChip({
  topic,
  className,
}: {
  readonly topic: string;
  readonly className?: string;
}) {
  const t = useT();
  return (
    <span className={withClass("shared-topic-chip", className)}>{t("topic.label", { topic })}</span>
  );
}

export function StatusChip({
  tone,
  children,
  className,
}: {
  readonly tone: "attention" | "success" | "danger" | "neutral";
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={withClass("shared-status-chip", className)} data-tone={tone}>
      {children}
    </span>
  );
}

export function SharedCard({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={withClass("shared-card", className)}>{children}</section>;
}

export function SectionHeader({ children }: { readonly children: ReactNode }) {
  return <div className="shared-section-header">{children}</div>;
}

export function MetaLine({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={withClass("shared-meta-line", className)}>{children}</div>;
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <p className="shared-empty-state">{children}</p>;
}

export function SharedLink({
  href,
  children,
  onClick,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly onClick?: () => void;
}) {
  return (
    <a className="shared-link" href={href} onClick={onClick}>
      {children}
    </a>
  );
}
