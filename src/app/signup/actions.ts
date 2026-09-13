"use server";

import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { clientMemberships, clients, profiles } from "@/db/shared";
import { requestSignInCode } from "@/app/login/actions";
import { CLIENT_COOKIE } from "@/lib/clients";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveAgency } from "@/lib/tenancy/resolve";

export type SignupResult = { ok: true; email: string } | { ok: false; error: string; signIn?: boolean };

const schema = z.object({
  business: z.string().trim().min(2, "Enter your business name.").max(120),
  name: z.string().trim().min(2, "Enter your name.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  mobile: z
    .string()
    .trim()
    .regex(/^(\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}$/, "Enter a UK mobile number."),
  website: z.string().max(0).optional(), // honeypot: real users never fill it
});

const DEFAULT_HOURS = {
  mon: { start: "09:00", end: "17:00" },
  tue: { start: "09:00", end: "17:00" },
  wed: { start: "09:00", end: "17:00" },
  thu: { start: "09:00", end: "17:00" },
  fri: { start: "09:00", end: "17:00" },
};

// Per-IP signup budget: a public form on a live database deserves a floor.
const WINDOW_MS = 10 * 60_000;
const BUDGET = 5;
const hits = new Map<string, number[]>();
async function allowed() {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "local").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= BUDGET) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

function toE164(uk: string) {
  const d = uk.replace(/\D/g, "");
  return d.startsWith("44") ? `+${d}` : `+44${d.replace(/^0/, "")}`;
}

/**
 * Self-serve signup from the storefront. Creates, in this order and only if
 * missing: the Supabase auth user, the customer (`clients`, same shape as the
 * agency's "new customer" form), the user's `profiles` row in this agency as
 * client_admin, and the membership. Then emails the sign-in code via the
 * normal login flow; the code step finishes the session.
 *
 * Guard: an email that already belongs to a customer in this agency is told
 * to sign in instead, so nobody can create a second business by mistake.
 */
export async function startSignup(formData: FormData): Promise<SignupResult> {
  const agency = await resolveAgency();
  if (!agency) return { ok: false, error: "This domain is not set up." };

  const parsed = schema.safeParse({
    business: formData.get("business"),
    name: formData.get("name"),
    email: formData.get("email"),
    mobile: formData.get("mobile"),
    website: String(formData.get("website") ?? ""),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  if (!(await allowed())) return { ok: false, error: "Too many attempts. Try again in a few minutes." };
  const { business, name, email } = parsed.data;
  const mobile = toE164(parsed.data.mobile);

  const admin = createServiceRoleClient();
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) return { ok: false, error: "Couldn't check your email right now. Try again." };
  let user = list.users.find((u) => u.email?.toLowerCase() === email) ?? null;

  if (user) {
    const existing = await db.query.profiles.findFirst({ where: and(eq(profiles.userId, user.id), eq(profiles.agencyId, agency.id)) });
    if (existing) {
      const membership = await db.query.clientMemberships.findFirst({ where: eq(clientMemberships.profileId, existing.id) });
      if (membership || existing.role === "super_admin" || existing.role === "agency_staff") {
        return { ok: false, error: "You already have an account here. Sign in instead.", signIn: true };
      }
    }
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (error || !data.user) return { ok: false, error: "Couldn't create your account. Try again." };
    user = data.user;
  }

  const clientId = await db.transaction(async (tx) => {
    const [client] = await tx
      .insert(clients)
      .values({ agencyId: agency.id, name: business, timezone: "Europe/London", businessHours: DEFAULT_HOURS, billingEmail: email })
      .returning({ id: clients.id });

    let profile = await tx.query.profiles.findFirst({ where: and(eq(profiles.userId, user!.id), eq(profiles.agencyId, agency.id)) });
    if (!profile) {
      const [created] = await tx
        .insert(profiles)
        .values({ userId: user!.id, agencyId: agency.id, email, fullName: name, phone: mobile, role: "client_admin" })
        .returning();
      profile = created;
    } else {
      await tx.update(profiles).set({ fullName: profile.fullName ?? name, phone: profile.phone ?? mobile }).where(eq(profiles.id, profile.id));
    }
    await tx.insert(clientMemberships).values({ profileId: profile.id, clientId: client.id }).onConflictDoNothing();
    return client.id;
  });

  // Pre-select the new business; validated against access on every read.
  const store = await cookies();
  store.set(CLIENT_COOKIE, clientId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });

  const fd = new FormData();
  fd.set("email", email);
  const sent = await requestSignInCode(fd);
  if (!sent.ok) return { ok: false, error: sent.error };
  return { ok: true, email };
}
