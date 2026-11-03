(() => {
  let theme = null;
  try {
    const saved = window.localStorage.getItem("agent-collab-viewer.theme");
    if (saved === "night-owl" || saved === "paper") theme = saved;
  } catch {
    // Use the system preference when browser storage is unavailable.
  }
  theme ??= window.matchMedia("(prefers-color-scheme: dark)").matches ? "night-owl" : "paper";
  document.documentElement.dataset.theme = theme;
})();
