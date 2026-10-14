export type ThemePreference = "light" | "dark" | "system";
const key = "lake.appearance";
declare global { interface Window { lakeAppearance?: ThemePreference; } }
let current: ThemePreference | undefined;

function preference(value: unknown): ThemePreference {
  return value === "dark" || value === "system" ? value : "light";
}

export function themePreference(): ThemePreference {
  if (current) return current;
  try {
    return preference(localStorage.getItem(key));
  } catch { /* Preferences remain usable when storage is unavailable. */ }
  return "light";
}

function applyTheme(preference: ThemePreference) {
  current = preference;
  window.lakeAppearance = preference;
  document.documentElement.dataset.theme = preference === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : preference;
}

export function setThemePreference(preference: ThemePreference) {
  try { localStorage.setItem(key, preference); } catch {}
  applyTheme(preference);
}

export function initializeAppearance() {
  // The native app can choose a different loopback port on every launch.
  // Seed its persisted preference before consulting this origin's storage.
  const initial = window.lakeAppearance ?? themePreference();
  try { localStorage.setItem(key, initial); } catch {}
  applyTheme(initial);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themePreference()));
  window.addEventListener("storage", event => { if (event.key === key) applyTheme(preference(event.newValue)); });
}
