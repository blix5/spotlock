import Link from "next/link";

import { getCurrentAccount } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { FocusCapture } from "@/components/FocusCapture";

// Minimum observed seconds before a track appears in the ranking. Without a
// floor, a track heard for eight seconds while focused reads as 100%.
const MIN_OBSERVED_SECONDS = 300;

type FocusRow = {
  spotify_track_id: string;
  track_name: string | null;
  artist_names: string | null;
  focused_seconds: number;
  observed_seconds: number;
};

export default async function FocusPage() {
  const account = await getCurrentAccount();

  if (!account) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-zinc-500">Log in with Spotify first.</p>
        <Link href="/" className="text-sm underline">
          Back
        </Link>
      </div>
    );
  }

  const { data, error } = await supabaseAdmin.rpc("focus_by_track", {
    min_seconds: MIN_OBSERVED_SECONDS,
  });
  const rows = (data ?? []) as FocusRow[];

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Focus tracking</h1>
          <Link href="/" className="text-sm text-zinc-500 hover:underline">
            Spotify stats
          </Link>
        </header>

        <section>
          <FocusCapture />
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Focus by track</h2>

          {error ? (
            <p className="text-sm text-zinc-500">
              Couldn&apos;t read focus data — has the migration been applied? ({error.message})
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing yet. Tracks appear here once they&apos;ve been observed for at least{" "}
              {MIN_OBSERVED_SECONDS / 60} minutes — shorter samples produce percentages that
              look confident and mean nothing.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {rows.map((row) => {
                const pct = row.observed_seconds
                  ? Math.round((row.focused_seconds / row.observed_seconds) * 100)
                  : 0;
                return (
                  <li
                    key={row.spotify_track_id}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {row.track_name ?? row.spotify_track_id}
                      <span className="text-zinc-500"> — {row.artist_names}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                        <span
                          className="block h-full bg-[#1DB954]"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="w-10 text-right font-mono text-xs">{pct}%</span>
                      <span className="w-16 text-right font-mono text-xs text-zinc-500">
                        {Math.round(row.observed_seconds / 60)}m
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
