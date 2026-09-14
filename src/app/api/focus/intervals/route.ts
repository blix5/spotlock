import { getCurrentAccount } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const TABLES = {
  attention: "attention_intervals",
  playback: "playback_intervals",
} as const;

type Stream = keyof typeof TABLES;

function tableFor(stream: unknown): string | null {
  return typeof stream === "string" && stream in TABLES ? TABLES[stream as Stream] : null;
}

// Whitelist per stream rather than spreading the request body into the
// insert: the service-role client bypasses RLS, so an unfiltered body would
// let the client write any column in any of these tables.
const FIELDS: Record<Stream, string[]> = {
  attention: ["state"],
  playback: ["spotify_track_id", "track_name", "artist_names", "album_name", "start_progress_ms"],
};

async function ownsSession(accountId: string, sessionId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("capture_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("account_id", accountId)
    .maybeSingle();
  return !!data;
}

/** Opens an interval. Returns its id so the client can close it later. */
export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const table = tableFor(body.stream);
  if (!table) return Response.json({ error: "unknown stream" }, { status: 400 });
  if (!body.sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
  if (!(await ownsSession(account.id, body.sessionId))) {
    return Response.json({ error: "unknown session" }, { status: 404 });
  }

  const row: Record<string, unknown> = {
    session_id: body.sessionId,
    started_at: body.startedAt ?? new Date().toISOString(),
  };
  for (const field of FIELDS[body.stream as Stream]) {
    if (body[field] !== undefined) row[field] = body[field];
  }

  const { data, error } = await supabaseAdmin.from(table).insert(row).select("id").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ id: data.id });
}

/** Closes an interval that POST opened. */
export async function PATCH(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const table = tableFor(body.stream);
  if (!table) return Response.json({ error: "unknown stream" }, { status: 400 });
  if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
  if (!body.sessionId || !(await ownsSession(account.id, body.sessionId))) {
    return Response.json({ error: "unknown session" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {
    ended_at: body.endedAt ?? new Date().toISOString(),
  };
  if (body.stream === "attention" && typeof body.sampleCount === "number") {
    patch.sample_count = body.sampleCount;
  }

  const { error } = await supabaseAdmin
    .from(table)
    .update(patch)
    .eq("id", body.id)
    .eq("session_id", body.sessionId);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
