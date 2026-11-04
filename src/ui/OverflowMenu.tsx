// The "More" menu of the narrow toolbar: a trigger (three dots) that opens a menu. Focus moves into
// the menu and arrow keys, Home and End move between items. Whenever the menu closes, focus goes
// back to the trigger unless something else already has it: Escape, choosing an item and Tab
// always return it (Tab closes the menu and keeps the tab order from the trigger); a click outside
// leaves focus on a focusable target that was clicked, and returns it to the trigger when the
// click landed on nothing focusable.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { IconButton } from "./IconButton";
import { MoreIcon } from "./icons";

const CloseMenu = createContext<() => void>(() => undefined);

export function OverflowMenu({
  label,
  children,
  onOpenChange,
}: {
  readonly label: string;
  readonly children: ReactNode;
  /** Told when the menu opens or closes (not when it unmounts while open). */
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const refocus = useRef<number | undefined>(undefined);

  const items = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
  ];

  /**
   * Focus is lost when it is on the body, on an element that has left the page, or still inside
   * the menu, whose focused item unmounts with it.
   */
  const focusLost = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      !document.body.contains(active) ||
      menu.current?.contains(active) === true
    );
  };

  const close = () => {
    const lost = focusLost();
    setOpen(false);
    if (lost) trigger.current?.focus();
  };

  useEffect(() => {
    // An unmount while open is not reported as a close: the toolbar uses that to move focus when
    // the layout changes under an open menu.
    onOpenChange?.(open);
    // onOpenChange is a callback of the parent and is not part of when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !menu.current?.contains(target) &&
        !trigger.current?.contains(target)
      ) {
        setOpen(false);
        // The click focuses its target (if it can be focused) after this event; when nothing took
        // the focus, give it back to the trigger.
        window.clearTimeout(refocus.current);
        refocus.current = window.setTimeout(() => {
          if (focusLost()) trigger.current?.focus();
        }, 0);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(
    () => () => {
      window.clearTimeout(refocus.current);
    },
    [],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(list.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        // Closing unmounts the focused item; keep the tab order by leaving from the trigger.
        event.preventDefault();
        close();
        break;
    }
  };

  return (
    <div className="overflow-menu">
      <IconButton
        ref={trigger}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          // Closing goes through close() so focus returns here even where a click does not focus
          // a button (Safari).
          if (open) close();
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreIcon />
      </IconButton>
      {open && (
        <div
          id={id}
          ref={menu}
          className="menu"
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          <CloseMenu.Provider value={close}>{children}</CloseMenu.Provider>
        </div>
      )}
    </div>
  );
}

/** A menu item: choosing it closes the menu; focus goes to the trigger unless the action took it. */
export function MenuItem({
  icon,
  children,
  role = "menuitem",
  checked,
  onSelect,
}: {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  readonly checked?: boolean;
  readonly onSelect: () => void;
}) {
  const close = useContext(CloseMenu);
  return (
    <button
      type="button"
      role={role}
      className="menu-item"
      tabIndex={-1}
      {...(role !== "menuitem" ? { "aria-checked": checked === true } : {})}
      onClick={() => {
        onSelect();
        close();
      }}
    >
      {icon !== undefined && <span className="menu-icon">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}

export function MenuGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="menu-group">
      <div className="menu-heading" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}
