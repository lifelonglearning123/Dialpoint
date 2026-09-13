import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/env";
import { AUTH_COOKIE } from "@/lib/supabase/cookie";

export function createClient() {
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { cookieOptions: { name: AUTH_COOKIE } });
}
