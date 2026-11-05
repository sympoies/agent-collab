import type { ReactNode, Ref } from "react";

import { useT } from "../i18n/LocaleProvider";

interface TopicBarProps {
  readonly className: string | undefined;
  readonly heading: ReactNode;
  readonly headingClass: string | undefined;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onBack: () => void;
  /** Controls that take too much room on a phone (jump to date, loaded count); null for none. */
  readonly menu: ReactNode;
}

/** The back control, the name and the options of the open view; it stays on top on a phone. */
export function TopicBar({
  className,
  heading,
  headingClass,
  headingRef,
  onBack,
  menu,
}: TopicBarProps) {
  const t = useT();
  return (
    <div className={`topic-bar${className === undefined ? "" : ` ${className}`}`}>
      <button
        type="button"
        className="back-to-topics"
        aria-label={t("nav.back")}
        title={t("nav.back")}
        onClick={onBack}
      >
        <span aria-hidden="true">←</span>
      </button>
      <h2 id="conversation-heading" className={headingClass} ref={headingRef} tabIndex={-1}>
        {heading}
      </h2>
      {menu !== null && (
        <details className="topic-menu">
          <summary aria-label={t("topic.menu")}>…</summary>
          <div className="topic-menu-body">{menu}</div>
        </details>
      )}
    </div>
  );
}
