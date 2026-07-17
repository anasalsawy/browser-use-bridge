import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { AppConfig } from "./config.js";

export type AuthContext = {
  token: string;
  user: User;
  supabase: SupabaseClient;
};

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticate(
  authorization: string | undefined,
  config: AppConfig,
): Promise<AuthContext | null> {
  const token = bearerToken(authorization);
  if (!token) return null;

  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return { token, user: data.user, supabase };
}
