import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agencyDomains } from "@/db/schema";
import { clientMemberships, profiles } from "@/db/shared";
import { canManage, isAgency } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { addAgencyDomain, createClient, inviteMember, removeAgencyDomain } from "./actions";

export default async function SettingsPage() {
  const { session, client } = await currentClient();
  if (!client) return null;
  const agencyRole = isAgency(session.role);
  const manage = canManage(session);

  const members = await db
    .select({ id: profiles.id, email: profiles.email, fullName: profiles.fullName, role: profiles.role })
    .from(clientMemberships)
    .innerJoin(profiles, eq(clientMemberships.profileId, profiles.id))
    .where(eq(clientMemberships.clientId, client.id));

  const domains = agencyRole ? await db.query.agencyDomains.findMany({ where: eq(agencyDomains.agencyId, session.agencyId) }) : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500">
          Signed in as {session.email} · {client.name}
        </p>
      </div>

      <section className="card">
        <h2 className="font-semibold">Team</h2>
        <p className="mt-1 text-sm text-slate-600">People who can manage {client.name}&apos;s numbers and answer on the browser softphone.</p>
        <ul className="mt-4 divide-y divide-slate-100">
          {members.length === 0 && <li className="py-3 text-sm text-slate-500">Only agency staff so far.</li>}
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <div className="font-medium">{m.fullName ?? m.email}</div>
                <div className="text-xs text-slate-500">{m.email}</div>
              </div>
              <span className="text-xs text-slate-500">{m.role.replace("_", " ")}</span>
            </li>
          ))}
        </ul>
        {manage && (
        <form action={inviteMember} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="clientId" value={client.id} />
          <label className="flex-1 space-y-1.5">
            <span className="text-sm font-medium">Invite by email</span>
            <input name="email" type="email" required className="input" placeholder="name@business.co.uk" />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium">Role</span>
            <select name="role" className="input">
              <option value="client_user">User</option>
              <option value="client_admin">Admin</option>
            </select>
          </label>
          <button className="btn-secondary" type="submit">
            Send invite
          </button>
        </form>
        )}
        <p className="mt-2 text-xs text-slate-500">They sign in with an emailed code; the invite is claimed on first sign-in. Same account works on the AI receptionist dashboard.</p>
      </section>

      {agencyRole && (
        <section className="card">
          <h2 className="font-semibold">Agency: new customer</h2>
          <p className="mt-1 text-sm text-slate-600">
            Create a customer under {session.agency.name}. They appear in the switcher here and in the Signal dashboard; invite their staff from Team afterwards.
          </p>
          <form action={createClient} className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="space-y-1.5 md:col-span-1">
              <span className="text-sm font-medium">Business name</span>
              <input name="name" required className="input" placeholder="Acme Plumbing Ltd" />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Billing email (optional)</span>
              <input name="billingEmail" type="email" className="input" placeholder="accounts@acme.co.uk" />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Timezone</span>
              <input name="timezone" defaultValue="Europe/London" className="input" />
            </label>
            <div className="md:col-span-3">
              <button className="btn-primary" type="submit">
                Create customer and switch to it
              </button>
            </div>
          </form>
        </section>
      )}

      {agencyRole && (
        <section className="card">
          <h2 className="font-semibold">Agency: domains for this product</h2>
          <p className="mt-1 text-sm text-slate-600">
            Each hostname here serves {session.agency.name}&apos;s branded number storefront. Point a CNAME at the platform, then mark it verified.
          </p>
          <ul className="mt-4 divide-y divide-slate-100">
            {domains.length === 0 && <li className="py-3 text-sm text-slate-500">No domains yet. In development the DEFAULT_AGENCY_SLUG fallback is used.</li>}
            {domains.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <span className="font-medium">{d.host}</span>{" "}
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ring-1 ${d.verified ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"}`}>
                    {d.verified ? "verified" : "pending DNS"}
                  </span>
                </div>
                <form action={removeAgencyDomain}>
                  <input type="hidden" name="id" value={d.id} />
                  <button className="text-xs text-slate-500 hover:text-red-600" type="submit">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <form action={addAgencyDomain} className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex-1 space-y-1.5">
              <span className="text-sm font-medium">Hostname</span>
              <input name="host" required className="input" placeholder="numbers.youragency.co.uk" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="verified" /> Mark verified now
            </label>
            <button className="btn-secondary" type="submit">
              Add domain
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
