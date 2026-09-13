import { createClient as createServiceClient } from "@supabase/supabase-js";
import { env } from "@/env";

/** Service-role client: admin auth operations only (generate OTP, list users). Never exposed to the browser. */
export function createServiceRoleClient() {
  return createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
