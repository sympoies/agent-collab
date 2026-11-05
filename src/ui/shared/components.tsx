import type { ReactNode } from "react";

import { personSlot, type People } from "../people";

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
}: {
  readonly name: string;
  readonly people: People;
  readonly avatar?: boolean;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
}) {
  return (
    <span
      className={className === undefined ? "shared-participant" : `shared-participant ${className}`}
      title={title}
      aria-label={ariaLabel}
      {...personSlot(people.slot(name))}
    >
      {avatar && (
        <span className="shared-avatar avatar" aria-hidden="true">
          {initials(name)}
        </span>
      )}
      <span>{people.label(name)}</span>
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
  return (
    <span
      className={className === undefined ? "shared-topic-chip" : `shared-topic-chip ${className}`}
    >
      #{topic}
    </span>
  );
}

export function StatusChip({
  tone,
  children,
}: {
  readonly tone: "attention" | "success" | "danger" | "neutral";
  readonly children: ReactNode;
}) {
  return (
    <span className="shared-status-chip" data-tone={tone}>
      {children}
    </span>
  );
}

export function SharedCard({ children }: { readonly children: ReactNode }) {
  return <section className="shared-card">{children}</section>;
}

export function SectionHeader({ children }: { readonly children: ReactNode }) {
  return <div className="shared-section-header">{children}</div>;
}

export function MetaLine({ children }: { readonly children: ReactNode }) {
  return <div className="shared-meta-line">{children}</div>;
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
