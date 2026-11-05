import { useT } from "../i18n/LocaleProvider";
import { IconButton } from "./IconButton";
import { MoonIcon, SunIcon } from "./icons";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Theme = "night-owl" | "paper";
type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export const THEME_KEY = "agent-collab-viewer.theme";

interface ThemeContextValue {
  readonly theme: Theme;
  readonly toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function savedTheme(storage: ThemeStorage): Theme | null {
  try {
    const saved = storage.getItem(THEME_KEY);
    if (saved === "night-owl" || saved === "paper") return saved;
  } catch {
    // Storage can be unavailable; system preference remains the default.
  }
  return null;
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night-owl" : "paper";
}

function bootstrappedTheme(): Theme | null {
  const theme = document.documentElement.dataset.theme;
  return theme === "night-owl" || theme === "paper" ? theme : null;
}

export function ThemeProvider({
  storage,
  children,
}: {
  readonly storage: ThemeStorage;
  readonly children: ReactNode;
}) {
  const [initial] = useState(() => savedTheme(storage));
  const hasThemeChoice = useRef(initial !== null);
  const [theme, setTheme] = useState<Theme>(() => initial ?? bootstrappedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor !== null) themeColor.content = theme === "night-owl" ? "#011627" : "#f4f3ed";
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) => {
      if (!hasThemeChoice.current) setTheme(event.matches ? "night-owl" : "paper");
    };
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === "night-owl" ? "paper" : "night-owl";
    hasThemeChoice.current = true;
    setTheme(next);
    try {
      storage.setItem(THEME_KEY, next);
    } catch {
      // Keep the selected theme for this page even when it cannot be persisted.
    }
  };

  const value = { theme, toggleTheme };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) throw new Error("useTheme must be inside ThemeProvider.");
  return context;
}

/** The label of the action: it names the theme the button switches to. */
export function useThemeAction(): {
  readonly label: string;
  readonly toggle: () => void;
  readonly toLight: boolean;
} {
  const { theme, toggleTheme } = useTheme();
  const t = useT();
  const toLight = theme === "night-owl";
  return {
    label: t("theme.use", { theme: t(toLight ? "theme.paper" : "theme.nightOwl") }),
    toggle: toggleTheme,
    toLight,
  };
}

export function ThemeToggle() {
  const { label, toggle, toLight } = useThemeAction();
  return (
    <IconButton label={label} onClick={toggle}>
      {toLight ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
}
