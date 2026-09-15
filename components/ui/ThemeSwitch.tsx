"use client";

import { useCallback, useSyncExternalStore, type JSX } from "react";

/**
 * Light / dark / auto, as one attribute on the root element.
 *
 * The whole mechanism is `data-theme` on <html>, because CSS can then rebind
 * the token set and every component follows without knowing a theme exists.
 * Nothing else in the app reads the current theme, and nothing needs to.
 *
 * The first paint is handled by an inline script in the layout, not here: a
 * React effect runs after paint, which is where the white flash comes from.
 *
 * One button rather than a three-way segmented control, because the rail is a
 * 48px glyph column and a segmented control does not fit in one. It cycles in
 * the order a reader expects — light, dark, then "follow the system".
 */
type Theme = "light" | "dark" | "auto";

const KEY = "aquasite-theme";
const ORDER: Theme[] = ["light", "dark", "auto"];
const LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  auto: "Match system",
};

/* The theme lives on <html>, not in React state. That attribute is the single
   source of truth — the inline bootstrap in the layout writes it before first
   paint — so this reads it as an external store rather than keeping a second
   copy that has to be reconciled with it after mount. */
const EVENT = "aquasite:themechange";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

function read(): Theme {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" || v === "dark" || v === "auto" ? v : "light";
}

function apply(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Private mode: the choice does not survive the session, which is fine. */
  }
  document.documentElement.setAttribute("data-theme", theme);
  // Lets the browser paint native chrome (scrollbars, form controls, the space
  // behind an overscroll) to match — the part a token set cannot reach.
  document.documentElement.style.colorScheme =
    theme === "auto" ? "light dark" : theme;
  window.dispatchEvent(new CustomEvent(EVENT));
}

function Glyph({ theme }: { theme: Theme }): JSX.Element {
  if (theme === "light") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path
          d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="2.8" y="4.5" width="18.4" height="13" rx="0.5" />
      <path d="M8.5 20.5h7" strokeLinecap="round" />
    </svg>
  );
}

export function ThemeSwitch(): JSX.Element {
  // "light" on the server: it is what the layout renders and what the bootstrap
  // falls back to, so the first client snapshot matches the markup.
  const theme = useSyncExternalStore(subscribe, read, () => "light" as Theme);

  const cycle = useCallback((): void => {
    apply(ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length]);
  }, []);

  return (
    <button
      type="button"
      className="rail-btn"
      onClick={cycle}
      data-tip={LABEL[theme]}
      aria-label={`Theme: ${LABEL[theme]}. Activate to change.`}
    >
      <Glyph theme={theme} />
    </button>
  );
}
