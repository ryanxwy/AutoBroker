/**
 * Toast — the in-app surface for a background notification delivered while the
 * window is focused. The Electron shell's notify() ladder, when the window has
 * focus, posts the notification into the renderer as a `autobroker:notify`
 * window CustomEvent (injected via webContents.executeJavaScript — there is no
 * preload/IPC bridge, the renderer loads over localhost HTTP). This component
 * listens for that event and shows a transient strip that reuses the
 * .scope-notice token language (no new visual vocabulary), auto-dismissing
 * after a few seconds.
 *
 * In a plain browser (no Electron shell) the event never fires, so this renders
 * nothing — it is purely additive to the web lane.
 */

import { useEffect, useState } from "react";

interface ToastDetail {
  title: string;
  body: string;
  deepLink: string;
}

const DISMISS_MS = 6000;

export function Toast(): JSX.Element | null {
  const [toast, setToast] = useState<ToastDetail | null>(null);

  useEffect(() => {
    const onNotify = (e: Event): void => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (detail === null || typeof detail !== "object") return;
      setToast({
        title: String(detail.title ?? ""),
        body: String(detail.body ?? ""),
        deepLink: String(detail.deepLink ?? "/"),
      });
    };
    window.addEventListener("autobroker:notify", onNotify);
    return () => window.removeEventListener("autobroker:notify", onNotify);
  }, []);

  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast]);

  if (toast === null) return null;

  return (
    <div className="app-toast" data-testid="app-toast" role="status">
      <strong>{toast.title}</strong>
      <span>{toast.body}</span>
      <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>
        ×
      </button>
    </div>
  );
}
