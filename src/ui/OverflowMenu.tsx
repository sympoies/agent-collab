// The "More" menu of the narrow toolbar: a trigger (three dots) that opens a menu. Focus moves into
// the menu, arrow keys, Home and End move between items, Escape closes it and returns focus to the
// trigger, as does choosing an item; a click outside or Tab closes it.

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

const CloseMenu = createContext<(returnFocus: boolean) => void>(() => undefined);

export function OverflowMenu({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const items = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
  ];

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };

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
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

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
        close(true);
        break;
      case "Tab":
        setOpen(false);
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
          setOpen(!open);
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

/** A menu item: choosing it closes the menu and returns focus to the trigger. */
export function MenuItem({
  icon,
  children,
  role = "menuitem",
  checked,
  onSelect,
  keepFocus = false,
}: {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly role?: "menuitem" | "menuitemradio";
  readonly checked?: boolean;
  readonly onSelect: () => void;
  /** Leave focus where the action puts it (for example when it opens another screen). */
  readonly keepFocus?: boolean;
}) {
  const close = useContext(CloseMenu);
  return (
    <button
      type="button"
      role={role}
      className="menu-item"
      tabIndex={-1}
      {...(role === "menuitemradio" ? { "aria-checked": checked === true } : {})}
      onClick={() => {
        onSelect();
        close(!keepFocus);
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
