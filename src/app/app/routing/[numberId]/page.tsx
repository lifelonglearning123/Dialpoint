import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers, routingPolicies } from "@/db/schema";
import { canManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { formatUk, typeLabel } from "@/lib/format";
import { clientAgents } from "@/lib/routing/agents";
import { describePolicy, parsePolicy, TEMPLATE_LABELS, type PeriodRoute, type Policy, type TemplateName } from "@/lib/routing/policy";
import { savePolicy } from "../actions";
import { RouteForm } from "./route-form";

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_SHORT: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** "Mon–Fri 09:00–17:30, Sat 10:00–14:00", or null when no hours are set. */
function hoursSummary(hours: Record<string, { start: string; end: string } | null> | null | undefined): string | null {
  const groups: Array<{ from: string; to: string; window: string }> = [];
  for (const d of DAY_ORDER) {
    const h = hours?.[d];
    if (!h?.start || !h?.end) continue;
    const window = `${h.start}–${h.end}`;
    const last = groups[groups.length - 1];
    if (last && last.window === window && DAY_ORDER.indexOf(last.to as (typeof DAY_ORDER)[number]) === DAY_ORDER.indexOf(d) - 1) last.to = d;
    else groups.push({ from: d, to: d, window });
  }
  if (groups.length === 0) return null;
  return groups.map((g) => `${DAY_SHORT[g.from]}${g.to !== g.from ? `–${DAY_SHORT[g.to]}` : ""} ${g.window}`).join(", ");
}

export default async function EditRoutingPage({
  params,
  searchParams,
}: {
  params: Promise<{ numberId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ numberId }, sp] = await Promise.all([params, searchParams]);
  const { client, session } = await currentClient();
  if (!client) return null;
  const manage = canManage(session);
  const number = await db.query.numbers.findFirst({ where: and(eq(numbers.id, numberId), eq(numbers.clientId, client.id), ne(numbers.status, "released")) });
  if (!number) notFound();
  const [row, agentList] = await Promise.all([
    db.query.routingPolicies.findFirst({ where: and(eq(routingPolicies.numberId, number.id), eq(routingPolicies.active, true)) }),
    clientAgents(client.id),
  ]);

  let current: Policy | null = null;
  try {
    current = row ? parsePolicy(row.policy) : null;
  } catch {
    current = null;
  }
  const names = Object.fromEntries(agentList.map((a) => [a.id, a.name]));
  const retell = agentList.filter((a) => a.platform === "retell");
  // An agent this number already uses stays selectable even if Signal no longer lists it.
  const inUse = [current?.settings?.inHours.agentId, current?.settings?.outOfHours.agentId, current?.aiAgentId].filter((id): id is string => !!id);
  for (const id of inUse) if (!retell.some((a) => a.id === id)) retell.push({ id, name: names[id] ?? `Agent ${id}`, platform: "retell" });

  const fallbackAgent = current?.aiAgentId ?? retell[0]?.id;
  const initial = (saved: PeriodRoute | undefined, mode: PeriodRoute["mode"]): PeriodRoute =>
    saved ?? { mode, ringSeconds: 20, agentId: fallbackAgent };
  const hours = hoursSummary(client.businessHours as Record<string, { start: string; end: string } | null>);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/app/routing" className="text-sm text-slate-500 hover:text-slate-900">
          ← Routing
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tabular-nums">{formatUk(number.e164)}</h1>
        <p className="text-sm text-slate-500">
          {number.label ?? typeLabel(number.type)}
          {row ? ` · routing version ${row.version}` : " · no routing saved yet"}
        </p>
      </div>

      {sp.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{sp.error}</p>}

      {!manage && (
        <div className="card space-y-2">
          <h2 className="font-semibold">{current ? (TEMPLATE_LABELS[(current.template ?? "custom") as TemplateName]?.title ?? "Custom") : "Default: ring your phones, then voicemail"}</h2>
          <ul className="space-y-0.5 text-sm text-slate-600">
            {(current ? describePolicy(current, names) : []).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">Only admins of {client.name} can change routing.</p>
        </div>
      )}

      {manage && (
        <form action={savePolicy} className="space-y-6">
          <input type="hidden" name="numberId" value={number.id} />
          <RouteForm
            clientName={client.name}
            hours={hours}
            agents={retell.map(({ id, name }) => ({ id, name }))}
            // 'ghl' rows are Signal's placeholders for staff and phone-line calls, not AI agents.
            unsupportedAgents={agentList.filter((a) => a.platform === "elevenlabs").map((a) => ({ name: a.name, platform: a.platform }))}
            inHours={initial(current?.settings?.inHours, "forward_then_ai")}
            outOfHours={initial(current?.settings?.outOfHours, "ai")}
            record={current?.record ?? false}
            announceRecording={current?.record ? (current.announceRecording ?? false) : true}
          />
          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary">
              Save routing
            </button>
            <Link href="/app/routing" className="btn-secondary">
              Cancel
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
