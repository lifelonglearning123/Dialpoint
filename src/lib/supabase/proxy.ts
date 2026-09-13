import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { AUTH_COOKIE } from "@/lib/supabase/cookie";

/**
 * Paths reachable with no session. Everything else bounces to /login.
 * Twilio, Signal and Stripe call the API paths server-to-server and
 * authenticate themselves (signature, bearer secret, HMAC), never by cookie.
 */
const PUBLIC_PATHS = [
  "/login",
  "/signup", // self-serve customer signup from the storefront
  "/auth",
  "/api/auth",
  "/api/voice", // Twilio voice webhooks
  "/api/webhooks", // Twilio regulatory + Stripe
  "/api/partner", // Signal → this app
  "/api/cron",
];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: AUTH_COOKIE },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = path === "/" || PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return response;
}
