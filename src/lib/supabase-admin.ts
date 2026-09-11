import { createClient } from "@supabase/supabase-js";

// Service-role client for server-only code (Route Handlers, server
// components). Never import this from a Client Component - the service
// role key bypasses RLS entirely.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export type SpotifyAccount = {
  id: string;
  spotify_user_id: string;
  display_name: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  created_at: string;
  updated_at: string;
};
