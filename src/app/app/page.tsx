import Link from "next/link";
import { and, desc, eq, gte, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { calls, numbers } from "@/db/schema";
import { currentClient } from "@/lib/clients";
import { StatusPill, daysAgo, formatUk, typeLabel } from "@/lib/format";

export default async function OverviewPage() {
  const { client } = await currentClient();
  if (!client) return null;

  const [nums, recent] = await Promise.all([
    db.query.numbers.findMany({
      where: and(eq(numbers.clientId, client.id), ne(numbers.status, "released")),
      orderBy: [desc(numbers.createdAt)],
    }),
    db.query.calls.findMany({
      where: and(eq(calls.clientId, client.id), gte(calls.startedAt, daysAgo(7))),
      orderBy: [desc(calls.startedAt)],
      limit: 10,
    }),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{client.name}</h1>
          <p className="text-sm text-slate-500">Your numbers, who answers them, and what happened on every call.</p>
        </div>
        <Link href="/app/numbers/new" className="btn-primary">
          Buy a number
        </Link>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">Numbers</div>
          <div className="mt-1 text-3xl font-semibold">{nums.length}</div>
          <div className="mt-1 text-xs text-slate-500">
            {nums.filter((n) => n.status === "active").length} active · {nums.filter((n) => n.status === "verifying").length} verifying
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">Calls, last 7 days</div>
          <div className="mt-1 text-3xl font-semibold">{recent.length}</div>
          <div className="mt-1 text-xs text-slate-500">
            {recent.filter((c) => c.outcome === "human").length} answered by you · {recent.filter((c) => c.outcome === "ai").length} by the AI ·{" "}
            {recent.filter((c) => c.outcome === "voicemail").length} voicemail
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-slate-500">AI receptionist</div>
          <div className="mt-1 text-lg font-semibold">Not connected</div>
          <div className="mt-1 text-xs text-slate-500">Add one from Routing when you&apos;re ready.</div>
        </div>
      </section>

      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Your numbers</h2>
          <Link href="/app/numbers" className="text-sm text-slate-500 hover:text-slate-900">
            Manage
          </Link>
        </div>
        {nums.length === 0 ? (
          <p className="text-sm text-slate-600">
            No numbers yet.{" "}
            <Link href="/app/numbers/new" className="underline">
              Buy your first number
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {nums.map((n) => (
              <li key={n.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium tabular-nums">{formatUk(n.e164)}</div>
                  <div className="text-xs text-slate-500">
                    {n.label ?? typeLabel(n.type)}
                    {n.locality ? ` · ${n.locality}` : ""}
                  </div>
                </div>
                <StatusPill status={n.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
