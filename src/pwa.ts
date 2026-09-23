/** Register the service worker so the app is installable as a PWA. */
export function registerPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  // Avoid caching the Vite HMR bundle during local development, and clear
  // any SW left over from an earlier session that could serve stale CSS.
  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
    if ("caches" in window) {
      void caches.keys().then((keys) => {
        for (const key of keys) void caches.delete(key);
      });
    }
    return;
  }
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
