import Link from "next/link";

import { getCurrentAccount } from "@/lib/auth";
import {
  fetchRecentlyPlayed,
  fetchTopArtists,
  fetchTopTracks,
  getValidAccessToken,
  type TimeRange,
} from "@/lib/spotify";

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "short_term", label: "Last 4 weeks" },
  { value: "medium_term", label: "Last 6 months" },
  { value: "long_term", label: "All time" },
];

function isTimeRange(value: string | string[] | undefined): value is TimeRange {
  return TIME_RANGES.some((r) => r.value === value);
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_state:
    "Login request didn't match. Make sure you opened the app at http://127.0.0.1:3000 (not localhost), then try again.",
  unauthorized_account: "That Spotify account isn't the owner account for this app.",
  account_save_failed: "Couldn't save your Spotify account. Check the server logs.",
  access_denied: "You declined the Spotify permission request.",
};

export default async function Home({ searchParams }: PageProps<"/">) {
  const account = await getCurrentAccount();
  const params = await searchParams;

  if (!account) {
    const error = typeof params.error === "string" ? params.error : undefined;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-black">
        {error && (
          <p className="max-w-md text-sm text-red-600 dark:text-red-400">
            {ERROR_MESSAGES[error] ?? `Login failed: ${error}`}
          </p>
        )}
        <a
          href="/api/auth/login"
          className="rounded-full bg-[#1DB954] px-6 py-3 font-medium text-black"
        >
          Log in with Spotify
        </a>
      </div>
    );
  }

  const timeRange: TimeRange = isTimeRange(params.range) ? params.range : "medium_term";

  const accessToken = await getValidAccessToken(account);
  const [topArtists, topTracks, recentlyPlayed] = await Promise.all([
    fetchTopArtists(accessToken, timeRange),
    fetchTopTracks(accessToken, timeRange),
    fetchRecentlyPlayed(accessToken),
  ]);

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">
            {account.display_name ?? "Your"} Spotify stats
          </h1>
          <div className="flex items-center gap-4">
            <Link href="/focus" className="text-sm text-zinc-500 hover:underline">
              Focus tracking
            </Link>
            <a href="/api/auth/logout" className="text-sm text-zinc-500 hover:underline">
              Log out
            </a>
          </div>
        </header>

        <nav className="flex gap-2">
          {TIME_RANGES.map((r) => (
            <a
              key={r.value}
              href={`/?range=${r.value}`}
              className={`rounded-full px-4 py-1.5 text-sm ${
                r.value === timeRange
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {r.label}
            </a>
          ))}
        </nav>

        <section>
          <h2 className="mb-3 text-lg font-medium">Top artists</h2>
          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topArtists.map((artist, i) => (
              <li key={artist.id} className="flex flex-col items-center gap-2 text-center">
                <span className="text-xs text-zinc-500">#{i + 1}</span>
                {artist.images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={artist.images[0].url}
                    alt={artist.name}
                    className="h-24 w-24 rounded-full object-cover"
                  />
                )}
                <span className="text-sm font-medium">{artist.name}</span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Top tracks</h2>
          <ol className="flex flex-col gap-2">
            {topTracks.map((track, i) => (
              <li key={track.id} className="flex items-center gap-3">
                <span className="w-5 text-xs text-zinc-500">{i + 1}</span>
                {track.album.images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={track.album.images[0].url} alt={track.album.name} className="h-10 w-10" />
                )}
                <div>
                  <p className="text-sm font-medium">{track.name}</p>
                  <p className="text-xs text-zinc-500">
                    {track.artists.map((a) => a.name).join(", ")}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Recently played</h2>
          <ol className="flex flex-col gap-2">
            {recentlyPlayed.map((item, i) => (
              <li key={`${item.track.id}-${item.played_at}-${i}`} className="flex items-center justify-between text-sm">
                <span>
                  {item.track.name} — {item.track.artists.map((a) => a.name).join(", ")}
                </span>
                <span className="text-xs text-zinc-500">
                  {new Date(item.played_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
