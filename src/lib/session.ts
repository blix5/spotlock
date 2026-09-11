import { createHmac, timingSafeEqual } from "crypto";

const SECRET = process.env.SESSION_SECRET!;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function sign(payload: string) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

// Single-user app: the "session" just asserts which spotify_accounts row
// this browser is allowed to act as, signed so it can't be forged or
// tampered with client-side.
export function createSessionCookie(spotifyAccountId: string): string {
  const payload = JSON.stringify({
    id: spotifyAccountId,
    exp: Date.now() + MAX_AGE_SECONDS * 1000,
  });
  const encodedPayload = Buffer.from(payload).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifySessionCookie(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const [encodedPayload, signature] = cookie.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = sign(encodedPayload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const { id, exp } = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
    if (typeof id !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    return id;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "session";
export const SESSION_MAX_AGE = MAX_AGE_SECONDS;
