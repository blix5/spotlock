import { getCurrentAccount } from "@/lib/auth";
import { fetchCurrentlyPlaying, getValidAccessToken } from "@/lib/spotify";

/**
 * Server-side proxy for what's playing right now. This exists because the
 * Spotify token lives in a service-role-guarded table and must never reach
 * the browser (see src/lib/supabase-admin.ts) - the capture island polls
 * this route instead of Spotify directly.
 */
export async function GET() {
  const account = await getCurrentAccount();
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const accessToken = await getValidAccessToken(account);
    const playing = await fetchCurrentlyPlaying(accessToken);

    // Nothing playing is a normal state for focus tracking, not an error -
    // attention intervals carry on regardless of whether music is on.
    if (!playing?.item) return Response.json({ playing: null });

    return Response.json({
      playing: {
        trackId: playing.item.id,
        trackName: playing.item.name,
        artistNames: playing.item.artists.map((a) => a.name).join(", "),
        albumName: playing.item.album?.name ?? null,
        progressMs: playing.progress_ms ?? 0,
        isPlaying: playing.is_playing,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "playback fetch failed" },
      { status: 502 }
    );
  }
}
