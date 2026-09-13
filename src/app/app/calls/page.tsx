import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { callLegs, calls, voicemails } from "@/db/schema";
import { currentClient } from "@/lib/clients";
import { formatUk } from "@/lib/format";

const OUTCOME: Record<string, { label: string; cls: string }> = {
  human: { label: "You answered", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  ai: { label: "AI answered", cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  voicemail: { label: "Voicemail", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  missed: { label: "Missed", cls: "bg-red-50 text-red-700 ring-red-200" },
  blocked: { label: "Blocked", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
  in_progress: { label: "In progress", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
};

function dur(s: number | null | undefined) {
  if (!s) return "–";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

export default async function CallsPage() {
  const { client } = await currentClient();
  if (!client) return null;
  const rows = await db.query.calls.findMany({ where: eq(calls.clientId, client.id), orderBy: [desc(calls.startedAt)], limit: 100 });
  const ids = rows.map((r) => r.id);
  const [legs, vms] = ids.length
    ? await Promise.all([
        db.query.callLegs.findMany({ where: inArray(callLegs.callId, ids) }),
        db.query.voicemails.findMany({ where: inArray(voicemails.callId, ids) }),
      ])
    : [[], []];
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: client.timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Calls</h1>
        <p className="text-sm text-slate-500">Every call, who took it, and the route it followed.</p>
      </div>
      <div className="card p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-600">No calls yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((c) => {
              const o = OUTCOME[c.outcome] ?? OUTCOME.in_progress;
              const myLegs = legs.filter((l) => l.callId === c.id);
              const accepted = myLegs.find((l) => l.accepted);
              const vm = vms.find((v) => v.callId === c.id);
              return (
                <li key={c.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-slate-500 tabular-nums">{fmt.format(c.startedAt)}</span>
                      <span className="font-medium tabular-nums">{c.callerName ?? formatUk(c.fromE164)}</span>
                      {c.callerName && <span className="text-xs text-slate-500 tabular-nums">{formatUk(c.fromE164)}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${o.cls}`}>{o.label}</span>
                      <span className="text-slate-500 tabular-nums">{dur(c.durationSeconds)}</span>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    to {formatUk(c.toE164)}
                    {accepted ? ` · answered on ${accepted.kind === "human_client" ? "the browser" : formatUk(accepted.target ?? "")}` : ""}
                    {c.aiSummary ? ` · ${c.aiSummary}` : ""}
                  </div>
                  {vm && (
                    <div className="mt-2 rounded-md bg-amber-50 p-3 text-sm">
                      <div className="font-medium text-amber-800">Voicemail{vm.durationSeconds ? ` · ${dur(vm.durationSeconds)}` : ""}</div>
                      {vm.summary && <div className="mt-1 text-amber-900">{vm.summary}</div>}
                      <div className="mt-1 text-xs text-amber-800/80">{vm.transcript ?? "Transcribing…"}</div>
                    </div>
                  )}
                  <details className="mt-2 text-xs text-slate-500">
                    <summary className="cursor-pointer">Route trace</summary>
                    <ol className="mt-1 space-y-0.5 font-mono">
                      {(c.routeTrace ?? []).map((t, i) => (
                        <li key={i}>
                          {t.at.slice(11, 19)} {t.step}
                          {Object.keys(t.data).length ? " " + JSON.stringify(t.data) : ""}
                        </li>
                      ))}
                    </ol>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
