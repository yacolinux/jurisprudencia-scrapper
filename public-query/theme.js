(() => {
  const cookieName = "juris-theme";
  const readCookie = () => document.cookie.match(new RegExp("(?:^|; )" + cookieName + "=([^;]*)"))?.[1];
  const readStoredTheme = () => {
    try { return readCookie() || window.localStorage.getItem(cookieName); } catch { return readCookie(); }
  };
  const initialTheme = readStoredTheme() === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = initialTheme;

  const updateButtons = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    document.querySelectorAll(".theme-toggle").forEach((button) => {
      button.textContent = dark ? "Modo claro" : "Modo oscuro";
      button.setAttribute("aria-label", dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
      button.setAttribute("aria-pressed", String(dark));
    });
  };

  const setTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    document.cookie = `${cookieName}=${theme}; Max-Age=31536000; Path=/; SameSite=Lax`;
    try { window.localStorage.setItem(cookieName, theme); } catch { /* La cookie mantiene la preferencia entre puertos. */ }
    updateButtons();
  };

  const initialize = () => {
    updateButtons();
    document.querySelectorAll(".theme-toggle").forEach((button) => {
      button.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
    });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
