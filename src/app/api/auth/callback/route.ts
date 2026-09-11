import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, getSpotifyProfile } from "@/lib/spotify";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createSessionCookie, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";

const STATE_COOKIE_NAME = "spotify_oauth_state";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;

function failure(reason: string) {
  const response = NextResponse.redirect(`${APP_URL}/?error=${encodeURIComponent(reason)}`);
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const error = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE_NAME)?.value;

  if (error) return failure(error);
  if (!code || !state || !expectedState || state !== expectedState) {
    return failure("invalid_state");
  }

  const tokens = await exchangeCodeForToken(code);
  const profile = await getSpotifyProfile(tokens.access_token);

  if (profile.id !== process.env.SPOTIFY_OWNER_USER_ID) {
    return failure("unauthorized_account");
  }

  const { data: account, error: dbError } = await supabaseAdmin
    .from("spotify_accounts")
    .upsert(
      {
        spotify_user_id: profile.id,
        display_name: profile.display_name,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      },
      { onConflict: "spotify_user_id" }
    )
    .select()
    .single();

  if (dbError || !account) {
    return failure("account_save_failed");
  }

  const response = NextResponse.redirect(APP_URL);
  response.cookies.delete(STATE_COOKIE_NAME);
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: createSessionCookie(account.id),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return response;
}
