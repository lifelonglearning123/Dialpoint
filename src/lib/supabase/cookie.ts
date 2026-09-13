/**
 * This app's session cookie name. Signal (and every other app on the same
 * Supabase project) uses the default `sb-<ref>-auth-token`; on localhost all
 * ports share one cookie jar, so two apps on the default name would keep
 * rotating each other's refresh token ("Invalid Refresh Token: Refresh Token
 * Not Found"). A distinct name keeps the sessions independent.
 */
export const AUTH_COOKIE = "tb-auth";
