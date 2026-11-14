// Theme bootstrap (design D4): a classic script loaded synchronously in <head>
// as /theme.js, before the stylesheet, so the stored theme applies before the
// first paint. With "dark" or "light" stored under localStorage "theme" it
// sets `data-theme` on <html>; with nothing stored it sets nothing and the CSS
// follows `prefers-color-scheme`. It also sets the browser's theme colour to
// the page background of the theme in effect.
{
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {
    // Storage blocked: follow the system preference.
  }
  const root = document.documentElement;
  if (stored === "dark" || stored === "light") root.dataset.theme = stored;
  const light = stored === "light" || (stored !== "dark" && matchMedia("(prefers-color-scheme: light)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#f3f3f1" : "#0f0f0f");
}
