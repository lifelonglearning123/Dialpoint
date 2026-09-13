"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { agencyDomains } from "@/db/schema";
import { invites } from "@/db/shared";
import { isAgency, requireClientAccess, requireSession } from "@/lib/auth";
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
