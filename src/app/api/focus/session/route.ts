import { getCurrentAccount } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const INTERVAL_TABLES = ["attention_intervals", "playback_intervals"] as const;

/**
 * Opens a capture session. Also closes anything the previous session left
 * open - a browser crash or a hard refresh leaves intervals with a null
 * ended_at, and those poison duration queries (an unbounded tstzrange makes
 * every overlap calculation return null). Closing them at their session's
 * end time is a guess, but a bounded one beats an open range forever.
 */
export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const now = new Date().toISOString();

  const { data: orphans } = await supabaseAdmin
    .from("capture_sessions")
    .select("id, started_at")
    .eq("account_id", account.id)
    .is("ended_at", null);

  for (const orphan of orphans ?? []) {
    for (const table of INTERVAL_TABLES) {
      await supabaseAdmin
        .from(table)
        .update({ ended_at: now })
        .eq("session_id", orphan.id)
        .is("ended_at", null);
    }
    await supabaseAdmin.from("capture_sessions").update({ ended_at: now }).eq("id", orphan.id);
  }

  const { data, error } = await supabaseAdmin
    .from("capture_sessions")
    .insert({
      account_id: account.id,
      camera_enabled: !!body.cameraEnabled,
    })
    .select("id")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ sessionId: data.id, closedOrphans: orphans?.length ?? 0 });
}

/** Updates the camera flag mid-session, or ends the session. */
export async function PATCH(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { sessionId, ended, cameraEnabled } = await request.json();
  if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  if (typeof cameraEnabled === "boolean") patch.camera_enabled = cameraEnabled;

  if (ended) {
    patch.ended_at = now;
    for (const table of INTERVAL_TABLES) {
      await supabaseAdmin
        .from(table)
        .update({ ended_at: now })
        .eq("session_id", sessionId)
        .is("ended_at", null);
    }
  }

  // Scoped by account_id as well as id so a forged sessionId can't touch
  // another account's row, even though this is currently single-user.
  const { error } = await supabaseAdmin
    .from("capture_sessions")
    .update(patch)
    .eq("id", sessionId)
    .eq("account_id", account.id);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
