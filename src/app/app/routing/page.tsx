import Link from "next/link";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { closures, humanTargets, numbers, routingPolicies } from "@/db/schema";
import { canManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { StatusPill, formatUk, typeLabel } from "@/lib/format";
import { clientAgents } from "@/lib/routing/agents";
import { describePolicy, parsePolicy, policyMissingAgent, TEMPLATE_LABELS, type TemplateName } from "@/lib/routing/policy";
import { addBrowserTarget, addClosure, addPhoneTarget, deleteTarget, moveTarget, removeClosure, saveBusinessHours, toggleTarget } from "./actions";

const DAYS: Array<[string, string]> = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];

export default async function RoutingPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const sp = await searchParams;
  const { client, session } = await currentClient();
  if (!client) return null;
  const manage = canManage(session);

  const [nums, targets, closureRows, agentList] = await Promise.all([
    db.query.numbers.findMany({ where: and(eq(numbers.clientId, client.id), ne(numbers.status, "released")), orderBy: [desc(numbers.createdAt)] }),
    db.query.humanTargets.findMany({ where: eq(humanTargets.clientId, client.id), orderBy: [asc(humanTargets.priority), asc(humanTargets.createdAt)] }),
    db.query.closures.findMany({ where: eq(closures.clientId, client.id), orderBy: [asc(closures.date)] }),
    clientAgents(client.id),
  ]);
  const agentNames = Object.fromEntries(agentList.map((a) => [a.id, a.name]));
  const policies = await Promise.all(
    nums.map((n) => db.query.routingPolicies.findFirst({ where: and(eq(routingPolicies.numberId, n.id), eq(routingPolicies.active, true)) })),
  );
  const hours = (client.businessHours ?? {}) as Record<string, { start: string; end: string } | null>;
  const hasBrowserTarget = targets.some((t) => t.kind === "client" && t.profileId === session.profileId);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Routing</h1>
        <p className="text-sm text-slate-500">Who answers each number, when, and what happens if they can&apos;t.</p>
        {!manage && <p className="mt-2 text-xs text-slate-500">You can view routing; only admins of {client.name} can change it.</p>}
        {sp.saved && <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Routing saved. It applies to the next call.</p>}
      </div>

      <section className="card">
        <h2 className="mb-4 font-semibold">Numbers</h2>
        {nums.length === 0 ? (
          <p className="text-sm text-slate-600">
            No numbers yet.{" "}
            <Link href="/app/numbers/new" className="underline">
              Buy one
            </Link>{" "}
            and its routing appears here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {nums.map((n, i) => {
              const row = policies[i];
              let lines: string[] = [];
              let title: string | null = "Default: ring your phones, then voicemail";
              let needsAgent = false;
              if (row) {
                try {
                  const p = parsePolicy(row.policy);
                  title = p.template === "simple" ? null : (TEMPLATE_LABELS[(p.template ?? "custom") as TemplateName]?.title ?? "Custom");
                  lines = describePolicy(p, agentNames);
                  needsAgent = policyMissingAgent(p);
                } catch {
                  title = "Invalid policy";
                }
              }
              return (
                <li key={n.id} className="flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium tabular-nums">{formatUk(n.e164)}</span>
                      <StatusPill status={n.status} />
                      <span className="text-xs text-slate-500">{n.label ?? typeLabel(n.type)}</span>
                    </div>
                    {title && <div className="mt-1 text-sm font-medium text-slate-800">{title}</div>}
                    <ul className={`mt-1 space-y-0.5 ${title ? "text-xs text-slate-500" : "text-sm text-slate-700"}`}>
                      {lines.map((l, k) => (
                        <li key={k}>{l}</li>
                      ))}
                    </ul>
                    {needsAgent && (
                      <p className="mt-2 text-xs text-amber-700">This route uses an AI agent but none is chosen; those steps are skipped until one is. Edit the routing to pick one.</p>
                    )}
                  </div>
                  <Link href={`/app/routing/${n.id}`} className="btn-secondary shrink-0">
                    {manage ? "Edit routing" : "View routing"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold">Transfers from the AI</h2>
        <p className="mb-4 text-sm text-slate-500">
          When the AI agent puts a caller through to a person, every enabled phone here rings at the same time. Numbers with no routing saved also ring these
          phones. Phones hear &ldquo;press 1 to accept&rdquo; so a mobile&apos;s own voicemail can never take the call.
        </p>
        {targets.length === 0 ? (
          <p className="mb-4 text-sm text-slate-500">No phones yet.</p>
        ) : (
          <ul className="mb-4 divide-y divide-slate-100">
            {targets.map((t, i) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                <div className={t.enabled ? "" : "opacity-50"}>
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="text-xs text-slate-500">{t.kind === "pstn" ? formatUk(t.value) : "Browser softphone"}</div>
                </div>
                {manage && (
                <div className="flex items-center gap-1 text-xs">
                  <form action={moveTarget}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="dir" value="up" />
                    <button className="btn-secondary px-2 py-1" disabled={i === 0} aria-label="Move up">
                      ↑
                    </button>
                  </form>
                  <form action={moveTarget}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="dir" value="down" />
                    <button className="btn-secondary px-2 py-1" disabled={i === targets.length - 1} aria-label="Move down">
                      ↓
                    </button>
                  </form>
                  <form action={toggleTarget}>
                    <input type="hidden" name="id" value={t.id} />
                    <button className="btn-secondary px-2 py-1">{t.enabled ? "Disable" : "Enable"}</button>
                  </form>
                  <form action={deleteTarget}>
                    <input type="hidden" name="id" value={t.id} />
                    <button className="btn-secondary px-2 py-1 text-red-600">Remove</button>
                  </form>
                </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
        <div className="grid gap-4 md:grid-cols-2">
          <form action={addPhoneTarget} className="space-y-2 rounded-lg border border-slate-200 p-4">
            <div className="text-sm font-medium">Add a phone</div>
            <input name="label" placeholder="Label, e.g. Sam's mobile" required className="input" />
            <input name="number" placeholder="+447700900123" required pattern="\+[1-9][0-9]{6,14}" className="input" />
            <button className="btn-primary">Add phone</button>
          </form>
          <form action={addBrowserTarget} className="space-y-2 rounded-lg border border-slate-200 p-4">
            <div className="text-sm font-medium">Answer in your browser</div>
            <p className="text-xs text-slate-500">Rings the Softphone page when it&apos;s open. Needs an active number.</p>
            <button className="btn-secondary" disabled={hasBrowserTarget}>
              {hasBrowserTarget ? "Already added" : "Add my browser"}
            </button>
          </form>
        </div>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold">Business hours</h2>
        <p className="mb-4 text-sm text-slate-500">
          Used by routes that behave differently out of hours. Leave every day unticked to be &ldquo;always open&rdquo;. Bank holidays (England &amp; Wales) count as closed days automatically.
        </p>
        <form action={saveBusinessHours} className="space-y-3">
          <fieldset disabled={!manage} className="contents">
          <div className="grid gap-2">
            {DAYS.map(([key, label]) => {
              const h = hours[key];
              return (
                <div key={key} className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex w-32 items-center gap-2">
                    <input type="checkbox" name={`${key}_open`} defaultChecked={!!h} />
                    {label}
                  </label>
                  <input type="time" name={`${key}_start`} defaultValue={h?.start ?? "09:00"} className="input w-32" />
                  <span className="text-slate-400">to</span>
                  <input type="time" name={`${key}_end`} defaultValue={h?.end ?? "17:30"} className="input w-32" />
                </div>
              );
            })}
          </div>
          <label className="block text-sm">
            <span className="font-medium">Timezone</span>
            <input name="timezone" defaultValue={client.timezone} className="input mt-1 w-64" />
          </label>
          {manage && <button className="btn-primary">Save hours</button>}
          </fieldset>
        </form>
      </section>

      <section className="card">
        <h2 className="font-semibold">Closed days</h2>
        <p className="mb-4 text-sm text-slate-500">Whole days treated as closed, on top of bank holidays.</p>
        {closureRows.length > 0 && (
          <ul className="mb-4 divide-y divide-slate-100">
            {closureRows.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="tabular-nums">{c.date}</span> · {c.label}
                </span>
                {manage && (
                  <form action={removeClosure}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className="text-xs text-red-600">Remove</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <form action={addClosure} className="flex flex-wrap items-end gap-2">
            <input type="date" name="date" required className="input w-44" />
            <input name="label" placeholder="e.g. Christmas shutdown" required className="input w-64" />
            <button className="btn-secondary">Add closed day</button>
          </form>
        )}
      </section>
    </div>
  );
}
