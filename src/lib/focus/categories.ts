import type { AppState } from "@/lib/cv/types";

export type AppCategory = "productive" | "distracting" | "neutral" | "unknown";

/**
 * Bundle id -> category. Inherently personal config with no correct default,
 * so this starts deliberately sparse: anything unmapped stays 'unknown'
 * rather than being forced into a bucket. A lot of 'unknown' showing up in
 * the data is itself the signal for what to add here.
 *
 * The same app is productive or distracting depending on the week, so expect
 * to edit this rather than treating it as settled.
 */
export const APP_CATEGORIES: Record<string, AppCategory> = {
  "com.microsoft.VSCode": "productive",
  "com.apple.dt.Xcode": "productive",
  "com.apple.Terminal": "productive",
  "com.googlecode.iterm2": "productive",
  "com.anthropic.claudefordesktop": "productive",

  "com.tinyspeck.slackmacgap": "neutral",
  "com.apple.mail": "neutral",
  "com.google.Chrome": "neutral",
  "com.apple.Safari": "neutral",

  "com.apple.MobileSMS": "distracting",
  "com.hnc.Discord": "distracting",
  "com.spotify.client": "distracting",
};

export function categorize(app: Pick<AppState, "bundleId">): AppCategory {
  return APP_CATEGORIES[app.bundleId] ?? "unknown";
}
