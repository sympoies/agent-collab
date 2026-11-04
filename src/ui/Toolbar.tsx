// The viewer's toolbar. Wide screens show every control as an icon button; narrow screens keep the
// refresh button and "Viewing as" and put the rest behind one "More" menu. The set of controls and
// their order are the same in both.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { LOCALE_NAMES, LOCALES } from "../i18n/catalog";
import { LanguageSwitcher, useLocale } from "../i18n/LocaleProvider";
import { IconButton } from "./IconButton";
import { FolderIcon, GlobeIcon, MoonIcon, SettingsIcon, SunIcon, UserIcon } from "./icons";
import { MenuGroup, MenuItem, OverflowMenu } from "./OverflowMenu";
import { ThemeToggle, useThemeAction } from "./ThemeProvider";

const NARROW = "(max-width: 720px)";

/** Whether the screen is phone-sized; false where matchMedia does not exist. */
export function useNarrow(): boolean {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null;
  const [narrow, setNarrow] = useState(query?.matches ?? false);
  useEffect(() => {
    if (query === null) return;
    const update = () => {
      setNarrow(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
    // The query object is stable for the page; only the listener matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return narrow;
}

export function Toolbar({
  primary,
  viewingAs,
  profileOpen,
  onToggleProfile,
  onPickLocalFolder,
  onOpenSettings,
}: {
  /** The refresh (or check-live) button, always first. */
  readonly primary: ReactNode;
  readonly viewingAs: ReactNode;
  readonly profileOpen: boolean;
  readonly onToggleProfile: () => void;
  readonly onPickLocalFolder: (() => void) | undefined;
  readonly onOpenSettings: () => void;
}) {
  const { t, locale, setLocale } = useLocale();
  const narrow = useNarrow();
  const theme = useThemeAction();
  const profile = t("bar.profile");
  const menuOpen = useRef(false);
  const bar = useRef<HTMLDivElement | null>(null);

  // Crossing the width threshold swaps the layout. When the menu was open its focused item is
  // gone, so focus goes to the control that replaces it: the More button on a phone, the first
  // control that left the menu (Profile & colors) on a wide screen.
  useEffect(() => {
    if (!menuOpen.current) return;
    menuOpen.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || !document.body.contains(active)) {
      bar.current
        ?.querySelector<HTMLElement>(
          narrow ? "[aria-haspopup=menu]" : "[aria-controls=profile-panel]",
        )
        ?.focus();
    }
  }, [narrow]);

  if (narrow) {
    return (
      <div ref={bar} className="bar-actions" data-layout="menu">
        {primary}
        {viewingAs}
        <OverflowMenu
          label={t("bar.more")}
          onOpenChange={(open) => {
            menuOpen.current = open;
          }}
        >
          <MenuItem
            role="menuitemcheckbox"
            checked={profileOpen}
            icon={<UserIcon />}
            onSelect={onToggleProfile}
          >
            {profile}
          </MenuItem>
          {onPickLocalFolder !== undefined && (
            <MenuItem icon={<FolderIcon />} onSelect={onPickLocalFolder}>
              {t("bar.localFolder")}
            </MenuItem>
          )}
          <MenuGroup label={t("language.label")}>
            {LOCALES.map((code) => (
              <MenuItem
                key={code}
                role="menuitemradio"
                checked={locale === code}
                icon={<GlobeIcon />}
                onSelect={() => {
                  setLocale(code);
                }}
              >
                {LOCALE_NAMES[code]}
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuItem icon={theme.toLight ? <SunIcon /> : <MoonIcon />} onSelect={theme.toggle}>
            {theme.label}
          </MenuItem>
          <MenuItem icon={<SettingsIcon />} onSelect={onOpenSettings}>
            {t("bar.settings")}
          </MenuItem>
        </OverflowMenu>
      </div>
    );
  }

  return (
    <div ref={bar} className="bar-actions" data-layout="icons">
      {primary}
      {viewingAs}
      <IconButton
        label={profile}
        aria-expanded={profileOpen}
        aria-controls="profile-panel"
        onClick={onToggleProfile}
      >
        <UserIcon />
      </IconButton>
      {onPickLocalFolder !== undefined && (
        <IconButton label={t("bar.localFolder")} onClick={onPickLocalFolder}>
          <FolderIcon />
        </IconButton>
      )}
      <LanguageSwitcher />
      <ThemeToggle />
      <IconButton label={t("bar.settings")} onClick={onOpenSettings}>
        <SettingsIcon />
      </IconButton>
    </div>
  );
}
