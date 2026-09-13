"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { agencyDomains } from "@/db/schema";
import { clientMemberships, clients, invites } from "@/db/shared";
import { isAgency, requireClientAccess, requireManage, requireSession } from "@/lib/auth";
import { CLIENT_COOKIE } from "@/lib/clients";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { emailCredsForAgency, ghlConfigured, sendGhlEmail } from "@/lib/email/ghl";
import { invalidateAgencyResolution } from "@/lib/tenancy/resolve";

/**
 * Invite a teammate to this client. Writes Signal's `invites` row in the same
 * shape Signal's own invite flow does, so the claim logic in src/lib/auth.ts
 * (and Signal's) both honour it. The user must exist in Supabase Auth to
 * receive a sign-in code; if not, they are created on first code request.
 */
export async function inviteMember(formData: FormData) {
  const session = await requireSession();
  requireManage(session);
  const parsed = z
    .object({ clientId: z.string().uuid(), email: z.string().email(), role: z.enum(["client_user", "client_admin"]) })
    .safeParse({ clientId: formData.get("clientId"), email: String(formData.get("email") ?? "").trim().toLowerCase(), role: formData.get("role") });
  if (!parsed.success) throw new Error("Enter a valid email and role.");
  const client = await requireClientAccess(session, parsed.data.clientId);

  await db
    .insert(invites)
    .values({
      agencyId: session.agencyId,
      email: parsed.data.email,
      role: parsed.data.role,
      clientId: client.id,
      invitedBy: session.profileId,
      token: randomBytes(24).toString("hex"),
      expiresAt: new Date(Date.now() + 14 * 86400_000),
    })
    .onConflictDoUpdate({
      target: [invites.agencyId, invites.email],
      set: { role: parsed.data.role, clientId: client.id, claimedAt: null, expiresAt: new Date(Date.now() + 14 * 86400_000) },
    });

  // Make sure an auth user exists so the sign-in code flow can find them.
  const { createServiceRoleClient } = await import("@/lib/supabase/service");
  const admin = createServiceRoleClient();
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (!list?.users.some((u) => u.email?.toLowerCase() === parsed.data.email)) {
    await admin.auth.admin.createUser({ email: parsed.data.email, email_confirm: true });
  }

  const creds = await emailCredsForAgency(session.agencyId);
  if (ghlConfigured(creds)) {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
    await sendGhlEmail(creds, {
      to: parsed.data.email,
      subject: `You've been added to ${client.name} on ${session.agency.name}`,
      html: `<p>${session.fullName ?? session.email} added you to <strong>${client.name}</strong>.</p><p>Sign in with your email at <a href="${base}/login">${base}/login</a>. You'll receive a one-time code.</p>`,
    }).catch((e) => console.warn("[invite] email failed", e));
  }
  revalidatePath("/app/settings");
}

export async function addAgencyDomain(formData: FormData) {
  const session = await requireSession();
  if (!isAgency(session.role)) throw new Error("Agency staff only.");
  const host = String(formData.get("host") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error("Enter a hostname like numbers.youragency.co.uk");
  await db
    .insert(agencyDomains)
    .values({ agencyId: session.agencyId, host, verified: formData.get("verified") === "on" })
    .onConflictDoNothing();
  invalidateAgencyResolution();
  revalidatePath("/app/settings");
}

export async function removeAgencyDomain(formData: FormData) {
  const session = await requireSession();
  if (!isAgency(session.role)) throw new Error("Agency staff only.");
  const id = String(formData.get("id") ?? "");
  await db.delete(agencyDomains).where(and(eq(agencyDomains.id, id), eq(agencyDomains.agencyId, session.agencyId)));
  invalidateAgencyResolution();
  revalidatePath("/app/settings");
}

/**
 * Create a customer (a Signal `clients` row) under this agency and switch to
 * it. Agency staff only. Same columns Signal's wizard go-live writes, so the
 * client is immediately usable from Signal too.
 */
export async function createClient(formData: FormData) {
  const session = await requireSession();
  if (!isAgency(session.role)) throw new Error("Agency staff only.");
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(120),
      timezone: z.string().trim().min(3).default("Europe/London"),
      billingEmail: z.string().email().optional().or(z.literal("")),
    })
    .safeParse({ name: formData.get("name"), timezone: formData.get("timezone") || "Europe/London", billingEmail: String(formData.get("billingEmail") ?? "").trim() });
  if (!parsed.success) throw new Error("Enter the business name.");

  const [row] = await db
    .insert(clients)
    .values({
      agencyId: session.agencyId,
      name: parsed.data.name,
      timezone: parsed.data.timezone,
      billingEmail: parsed.data.billingEmail || null,
      businessHours: { mon: { start: "09:00", end: "17:00" }, tue: { start: "09:00", end: "17:00" }, wed: { start: "09:00", end: "17:00" }, thu: { start: "09:00", end: "17:00" }, fri: { start: "09:00", end: "17:00" } },
    })
    .returning({ id: clients.id });
  // Agency staff see every client anyway; the membership just mirrors Signal's go-live shape.
  await db.insert(clientMemberships).values({ profileId: session.profileId, clientId: row.id }).onConflictDoNothing();

  const store = await cookies();
  store.set(CLIENT_COOKIE, row.id, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  redirect("/app");
}
