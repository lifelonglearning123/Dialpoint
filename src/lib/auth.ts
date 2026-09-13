import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { clientMemberships, clients, invites, profiles, type Role } from "@/db/shared";
import { createClient } from "@/lib/supabase/server";
import { resolveAgency, type ResolvedAgency } from "@/lib/tenancy/resolve";

/**
 * Session = Supabase user + Signal `profiles` row for the agency this host
 * resolves to. Same semantics as Signal's requireSession: a pending invite is
 * claimed on first sign-in and the agency owner's email is auto-promoted, so
 * an account works identically on both products.
 */
export type SessionContext = {
  userId: string;
  profileId: string;
  agencyId: string;
  agency: ResolvedAgency;
  email: string;
  role: Role;
  fullName: string | null;
};

export function isAgency(role: Role) {
  return role === "super_admin" || role === "agency_staff";
}

/** Agency staff and client admins change things; client users are read-only. */
export function canManage(session: Pick<SessionContext, "role">) {
  return isAgency(session.role) || session.role === "client_admin";
}

export function requireManage(session: Pick<SessionContext, "role">) {
  if (!canManage(session)) throw new Error("Only admins can change this.");
}

export async function getSession(): Promise<SessionContext | null> {
  const agency = await resolveAgency();
  if (!agency) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let profile = await db.query.profiles.findFirst({
    where: and(eq(profiles.userId, user.id), eq(profiles.agencyId, agency.id)),
  });

  if (!profile) {
    const email = (user.email ?? "").toLowerCase();
    const invite = email
      ? await db.query.invites.findFirst({ where: and(eq(invites.agencyId, agency.id), eq(invites.email, email)) })
      : null;
    const isOwner = !!email && !!agency.ownerEmail && email === agency.ownerEmail.toLowerCase();
    if ((!invite || invite.claimedAt) && !isOwner) return null;

    const usable = invite && !invite.claimedAt ? invite : null;
    const [created] = await db
      .insert(profiles)
      .values({
        userId: user.id,
        agencyId: agency.id,
        email: user.email ?? email,
        fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
        role: usable ? usable.role : "super_admin",
      })
      .returning();
    if (usable?.clientId) {
      await db.insert(clientMemberships).values({ profileId: created.id, clientId: usable.clientId }).onConflictDoNothing();
    }
    if (usable) await db.update(invites).set({ claimedAt: new Date() }).where(eq(invites.id, usable.id));
    profile = created;
  }

  return {
    userId: profile.userId,
    profileId: profile.id,
    agencyId: profile.agencyId,
    agency,
    email: profile.email,
    role: profile.role,
    fullName: profile.fullName,
  };
}

export async function requireSession(): Promise<SessionContext> {
  const agency = await resolveAgency();
  if (!agency) redirect("/login?error=No+workspace+is+configured+for+this+domain");
  const session = await getSession();
  if (!session) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.auth.signOut();
      redirect("/login?error=Account+not+authorised+for+this+workspace");
    }
    redirect("/login");
  }
  return session;
}

/** Clients this session may act on: all of the agency's for agency roles, memberships otherwise. */
export async function visibleClients(session: SessionContext) {
  if (isAgency(session.role)) {
    return db.query.clients.findMany({
      where: eq(clients.agencyId, session.agencyId),
      columns: { id: true, name: true, timezone: true, businessHours: true },
      orderBy: (c, { asc }) => [asc(c.name)],
    });
  }
  const rows = await db
    .select({ clientId: clientMemberships.clientId })
    .from(clientMemberships)
    .where(eq(clientMemberships.profileId, session.profileId));
  const ids = rows.map((r) => r.clientId);
  if (ids.length === 0) return [];
  return db.query.clients.findMany({
    where: and(inArray(clients.id, ids), eq(clients.agencyId, session.agencyId)),
    columns: { id: true, name: true, timezone: true, businessHours: true },
    orderBy: (c, { asc }) => [asc(c.name)],
  });
}

/** Throws unless the session may act on this client. */
export async function requireClientAccess(session: SessionContext, clientId: string) {
  const list = await visibleClients(session);
  const client = list.find((c) => c.id === clientId);
  if (!client) throw new Error("You do not have access to this client.");
  return client;
}
