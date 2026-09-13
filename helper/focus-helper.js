// Reports the frontmost macOS app over a localhost WebSocket, once a second.
//
// This exists because a browser page cannot see which application is
// frontmost: getDisplayMedia hands you pixels and nothing else - no window
// title, no app identity - deliberately, as a privacy boundary. So screen
// pixels can't answer "am I in Slack right now", and this can.
// See docs/cv-plan.md §3.
//
// Run alongside `npm run dev`:  node helper/focus-helper.js

const { WebSocketServer } = require("ws");
const { execFile } = require("child_process");

const PORT = Number(process.env.FOCUS_HELPER_PORT ?? 8787);
const POLL_MS = 1000;

// Bundle id and app name need no special permission. The window title does
// (Accessibility), so it's requested in a way that degrades to empty rather
// than failing the whole read - see the `try` in the AppleScript below.
const SCRIPT = `
tell application "System Events"
  set p to first application process whose frontmost is true
  set bid to bundle identifier of p
  set nm to name of p
  set title to ""
  try
    set title to name of front window of p
  end try
  return bid & "\\n" & nm & "\\n" & title
end tell
`;

function readFrontmost() {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", SCRIPT], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve(null);
      const [bundleId, appName, windowTitle] = stdout.trim().split("\n");
      if (!bundleId) return resolve(null);
      resolve({ bundleId, appName: appName || null, windowTitle: windowTitle || null });
    });
  });
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
let last = null;

wss.on("connection", (socket) => {
  // Send current state immediately so a client connecting mid-session
  // doesn't wait for the next app switch to learn where it is.
  if (last) socket.send(JSON.stringify(last));
});

setInterval(async () => {
  const app = await readFrontmost();
  if (!app) return;

  const unchanged =
    last &&
    last.bundleId === app.bundleId &&
    last.windowTitle === app.windowTitle;
  if (unchanged) return;

  last = app;
  const payload = JSON.stringify(app);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}, POLL_MS);

console.log(`[focus-helper] listening on ws://127.0.0.1:${PORT}`);
