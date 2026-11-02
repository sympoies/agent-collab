import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Theme = "night-owl" | "paper";
type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

const THEME_KEY = "agent-collab-viewer.theme";

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

export function ThemeProvider({
  storage,
  children,
}: {
  readonly storage: ThemeStorage;
  readonly children: ReactNode;
}) {
  const [initial] = useState(() => savedTheme(storage));
  const hasThemeChoice = useRef(initial !== null);
  const [theme, setTheme] = useState<Theme>(() => initial ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
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

export function ThemeToggle() {
  const context = useContext(ThemeContext);
  if (context === null) throw new Error("ThemeToggle must be inside ThemeProvider.");
  const next = context.theme === "night-owl" ? "Paper" : "Night Owl";
  return (
    <button type="button" aria-label={`Use ${next} theme`} onClick={context.toggleTheme}>
      {next}
    </button>
  );
}
