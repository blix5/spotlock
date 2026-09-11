import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export async function GET() {
  const response = NextResponse.redirect(process.env.NEXT_PUBLIC_APP_URL!);
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
