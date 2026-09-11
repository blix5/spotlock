import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getAuthorizeUrl } from "@/lib/spotify";

const STATE_COOKIE_NAME = "spotify_oauth_state";

export async function GET() {
  const state = randomBytes(16).toString("hex");

  const response = NextResponse.redirect(getAuthorizeUrl(state));
  response.cookies.set({
    name: STATE_COOKIE_NAME,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });
  return response;
}
