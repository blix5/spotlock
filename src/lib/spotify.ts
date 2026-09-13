import { supabaseAdmin, type SpotifyAccount } from "./supabase-admin";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI!;

export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
  // Added for focus tracking (docs/cv-plan.md §5). Changing this list forces
  // a re-auth of the owner account, so settle it in one pass.
  "user-read-playback-state",
  "user-read-currently-playing",
].join(" ");

export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getSpotifyProfile(accessToken: string): Promise<{ id: string; display_name: string | null }> {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify profile fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Returns a usable access token for this account, refreshing and
// persisting a new one first if the stored one is expired (or close to it).
export async function getValidAccessToken(account: SpotifyAccount): Promise<string> {
  const expiresAt = new Date(account.token_expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) {
    return account.access_token;
  }

  const refreshed = await refreshAccessToken(account.refresh_token);
  const tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  const { error } = await supabaseAdmin
    .from("spotify_accounts")
    .update({
      access_token: refreshed.access_token,
      // Spotify doesn't always rotate the refresh token - keep the old one if absent.
      refresh_token: refreshed.refresh_token ?? account.refresh_token,
      token_expires_at: tokenExpiresAt,
    })
    .eq("id", account.id);
  if (error) throw new Error(`Failed to persist refreshed token: ${error.message}`);

  return refreshed.access_token;
}

// Takes an already-resolved access token rather than the account, so a page
// making several calls in parallel refreshes at most once.
export async function spotifyFetch(accessToken: string, path: string) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify API error on ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export type TimeRange = "short_term" | "medium_term" | "long_term";

export type SpotifyArtist = {
  id: string;
  name: string;
  genres: string[];
  images: { url: string }[];
};

export type SpotifyTrack = {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
};

export type RecentlyPlayedItem = {
  played_at: string;
  track: SpotifyTrack;
};

export async function fetchTopArtists(accessToken: string, timeRange: TimeRange = "medium_term") {
  const data = await spotifyFetch(accessToken, `/me/top/artists?time_range=${timeRange}&limit=20`);
  return data.items as SpotifyArtist[];
}

export async function fetchTopTracks(accessToken: string, timeRange: TimeRange = "medium_term") {
  const data = await spotifyFetch(accessToken, `/me/top/tracks?time_range=${timeRange}&limit=20`);
  return data.items as SpotifyTrack[];
}

export async function fetchRecentlyPlayed(accessToken: string) {
  const data = await spotifyFetch(accessToken, `/me/player/recently-played?limit=50`);
  return data.items as RecentlyPlayedItem[];
}

export type CurrentlyPlaying = {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
};

// Deliberately not routed through spotifyFetch: this endpoint returns
// 204 No Content when nothing is playing, and res.json() on an empty body
// throws even though res.ok is true. Null here means "nothing playing",
// which is a normal state for focus tracking, not an error.
export async function fetchCurrentlyPlaying(accessToken: string): Promise<CurrentlyPlaying | null> {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`Spotify currently-playing failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // Spotify also returns 200 with a null item for some non-track contexts
  // (podcast episodes, local files), which we treat the same as silence.
  if (!data?.item?.id) return null;

  return { is_playing: !!data.is_playing, progress_ms: data.progress_ms ?? null, item: data.item };
}
