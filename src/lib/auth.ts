import { cookies } from "next/headers";
import { supabaseAdmin, type SpotifyAccount } from "./supabase-admin";
import { SESSION_COOKIE_NAME, verifySessionCookie } from "./session";

export async function getCurrentAccount(): Promise<SpotifyAccount | null> {
  const cookieStore = await cookies();
  const accountId = verifySessionCookie(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (!accountId) return null;

  const { data } = await supabaseAdmin
    .from("spotify_accounts")
    .select("*")
    .eq("id", accountId)
    .single();

  return data;
}
