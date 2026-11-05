import { useEffect } from "react";

/**
 * Shows the element with `id` (a message, or the end of the conversation) without a history
 * entry: a link to it would add one, and the back control and the system back would then have to
 * step over it. `data-jumped` marks the message like `:target` would.
 */
export function jumpInPage(id: string): boolean {
  const element = document.getElementById(id);
  if (element === null) return false;
  document.querySelector("[data-jumped]")?.removeAttribute("data-jumped");
  element.scrollIntoView();
  if (id.startsWith("msg-")) {
    element.setAttribute("data-jumped", "");
    // A link to a fragment would have moved the focus starting point to the target.
    element.focus({ preventScroll: true });
  }
  return true;
}

/**
 * Makes every plain link to an element of the page jump there without a history entry. A link
 * whose target is not on the page does nothing: navigating to it would add an entry.
 */
export function useInPageLinks(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
      const id = link?.getAttribute("href")?.slice(1) ?? "";
      if (id === "") return;
      event.preventDefault();
      jumpInPage(decodeURIComponent(id));
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
    };
  }, []);
}
