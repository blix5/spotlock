import type { AppState } from "@/lib/cv/types";

const DEFAULT_URL = "ws://127.0.0.1:8787";

export type HelperEvents = {
  onApp: (app: AppState) => void;
  onStatus: (connected: boolean) => void;
};

/**
 * Client for the local macOS helper (see helper/focus-helper.js).
 *
 * The helper exists because a browser page fundamentally cannot see which
 * application is frontmost - getDisplayMedia yields pixels and nothing else,
 * with no window title or app identity, deliberately. See docs/cv-plan.md §3.
 *
 * Note this ties capture to local development: browsers block ws:// from an
 * https:// page, so a TLS deploy would need a different transport.
 */
export function connectHelper(events: HelperEvents, url = DEFAULT_URL) {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    socket = new WebSocket(url);

    socket.onopen = () => events.onStatus(true);

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data?.bundleId) return;
        events.onApp({
          bundleId: data.bundleId,
          appName: data.appName ?? null,
          windowTitle: data.windowTitle ?? null,
        });
      } catch {
        // Helper sent something unparseable; ignore rather than tear down.
      }
    };

    const reconnect = () => {
      events.onStatus(false);
      socket = null;
      // The helper is a separate process the user starts by hand, so it
      // being down is an ordinary state, not an error. Keep retrying quietly
      // so starting it later just works.
      if (!closed) retry = setTimeout(open, 3000);
    };

    socket.onclose = reconnect;
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}
