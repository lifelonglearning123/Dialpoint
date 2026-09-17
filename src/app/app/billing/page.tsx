import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { formatPence, formatRate, NUMBER_TYPES, NUMBER_TYPE_LABELS, surchargePercent } from "@/lib/billing/pricing";
import { stripeConfigured } from "@/lib/billing/stripe";
import { activeNumberCountsByType, getSubscription, recentInvoices, totalCount } from "@/lib/billing/subscription";
import { usageSummary } from "@/lib/billing/usage";
import { currentClient } from "@/lib/clients";
import { openPortal } from "./actions";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

const STATE_COPY: Record<string, { tone: string; title: string; body: string }> = {
  past_due: {
    tone: "border-amber-200 bg-amber-50 text-amber-800",
    title: "Your last payment didn't go through",
    body: "We'll retry the card over the next 14 days. Update it now to keep your numbers ringing without interruption.",
  },
  unpaid: {
    tone: "border-red-200 bg-red-50 text-red-800",
    title: "Calls are paused",
    body: "The card was declined for over two weeks, so your numbers are paused. They are still yours: pay the open invoice and calls resume within a minute.",
  },
  cancelled: {
    tone: "border-slate-200 bg-slate-50 text-slate-700",
    title: "Subscription ended",
    body: "Your numbers were released when the subscription ended. Buy a number to start a new subscription.",
  },
};

export default async function BillingPage() {
  const { client } = await currentClient();
  if (!client) return null;

  const sub = await getSubscription(client.id);
  const plan = sub ? await db.query.plans.findFirst({ where: eq(plans.id, sub.planId) }) : null;
  const counts = await activeNumberCountsByType(client.id);
  const active = totalCount(counts);
  const summary = await usageSummary(client.id, plan ?? null, counts);
  const invoices = sub && stripeConfigured() ? await recentInvoices(client.id).catch(() => []) : [];
  const currency = plan?.currency ?? "GBP";
  const fmt = (p: number) => formatPence(p, currency);
  const banner = sub ? STATE_COPY[sub.state] : null;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Billing</h1>
          <p className="text-sm text-slate-500">What {client.name} pays each month, and where the minutes went.</p>
        </div>
        {sub && sub.state !== "cancelled" && (
          <form action={openPortal}>
            <button className="btn-secondary" type="submit">
              Manage billing
            </button>
          </form>
        )}
      </div>

      {banner && (
        <div className={`rounded-xl border px-5 py-4 text-sm ${banner.tone}`}>
          <div className="font-semibold">{banner.title}</div>
          <p className="mt-1">{banner.body}</p>
          {sub?.state !== "cancelled" && (
            <form action={openPortal} className="mt-3">
              <button className="btn-primary" type="submit">
                Update card
              </button>
            </form>
          )}
        </div>
      )}

      {!sub || !plan ? (
        <div className="card">
          <h2 className="font-semibold">No subscription yet</h2>
          <p className="mt-1 text-sm text-slate-600">
            A subscription starts the first time you buy a number: Twilio&apos;s monthly number charge, a monthly hosting charge per number, and the minutes you use, charged automatically.
          </p>
          <Link href="/app/numbers/new" className="btn-primary mt-4 inline-flex">
            Buy a number
          </Link>
        </div>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-4">
            <div className="card">
              <div className="text-xs uppercase tracking-wide text-slate-500">Plan</div>
              <div className="mt-1 text-lg font-semibold">{plan.name}</div>
              <div className="mt-1 text-xs text-slate-500">
                Hosting {fmt(plan.hostingMonthlyPence)} per number · Twilio number {NUMBER_TYPES.filter((t) => counts[t] > 0)
                  .map((t) => `${NUMBER_TYPE_LABELS[t]} ${fmt(plan.carrierMonthlyPence[t] ?? 0)}`)
                  .join(", ") || "per type"}{" "}
                · {summary.passthrough ? "calls at Twilio's cost" : `${plan.includedMinutes > 0 ? `${plan.includedMinutes} min included · ` : ""}${formatRate(plan.perMinutePence, currency)}/min`}
              </div>
            </div>
            <div className="card">
              <div className="text-xs uppercase tracking-wide text-slate-500">Fixed this period</div>
              <div className="mt-1 text-3xl font-semibold">{fmt(summary.fixedPence)}</div>
              <div className="mt-1 text-xs text-slate-500">
                {Math.max(active, 1)} active number{Math.max(active, 1) === 1 ? "" : "s"} · Twilio {fmt(summary.carrierPence)} + hosting {fmt(summary.hostingPence)}
              </div>
            </div>
            <div className="card">
              <div className="text-xs uppercase tracking-wide text-slate-500">Usage so far</div>
              <div className="mt-1 text-3xl font-semibold">{fmt(summary.projectedPence)}</div>
              <div className="mt-1 text-xs text-slate-500">
                {summary.passthrough
                  ? `Twilio's charges, passed on at cost${summary.unpricedLegs > 0 ? ` · ${summary.unpricedLegs} call${summary.unpricedLegs === 1 ? "" : "s"} awaiting Twilio's price` : ""}`
                  : `${summary.minutes.pooled} of ${summary.includedMinutes} included minutes used${summary.overageMinutes > 0 ? ` · ${summary.overageMinutes} over` : ""}`}
              </div>
            </div>
            <div className="card">
              <div className="text-xs uppercase tracking-wide text-slate-500">Next charge</div>
              <div className="mt-1 text-lg font-semibold">{summary.periodEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</div>
              <div className="mt-1 text-xs text-slate-500">
                estimated {fmt(summary.fixedPence + summary.projectedPence + summary.surchargePence)}
                {plan.surchargeBps > 0 ? ` incl. ${surchargePercent(plan.surchargeBps)}% card surcharge` : ""}
                {sub.cancelAtPeriodEnd ? " · cancels at period end" : ""}
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="font-semibold">Minutes this period</h2>
            <p className="mt-1 text-xs text-slate-500">
              {summary.periodStart.toLocaleDateString("en-GB")} to {summary.periodEnd.toLocaleDateString("en-GB")}. Rounded up per call, the way carriers bill.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Stat label="Forwarded to your phones" value={`${summary.minutes.forward} min`} />
              <Stat label="Callers' inbound minutes" value={`${summary.minutes.inbound} min`} />
              <Stat label="Browser softphone" value={`${summary.minutes.softphone} min`} />
              <Stat label="0800 inbound (always billed)" value={`${summary.freephoneMinutes} min`} sub={summary.passthrough ? "at Twilio's cost" : `${formatRate(plan.freephoneInboundPence, currency)}/min`} />
              <Stat label="Voicemails transcribed" value={String(summary.transcriptions)} sub={plan.voicemailTranscribePence ? `${formatRate(plan.voicemailTranscribePence, currency)} each` : "included"} />
            </div>
            {summary.passthrough ? (
              <p className="mt-4 text-xs text-slate-500">
                Every call is billed at exactly what Twilio charged for it. Twilio prices a call shortly after it ends; a call that has not been priced yet is billed on the next invoice, never
                estimated.
              </p>
            ) : (
              <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full ${summary.overageMinutes > 0 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${Math.min(100, summary.includedMinutes ? (summary.minutes.pooled / summary.includedMinutes) * 100 : summary.minutes.pooled ? 100 : 0)}%` }}
                />
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">AI receptionist minutes are billed separately by your AI receptionist subscription and never appear here.</p>
          </section>

          <section className="card">
            <h2 className="font-semibold">Invoices</h2>
            {invoices.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No invoices to show yet. Invoices are raised when you add your card and then on the same day each month; the next is due {summary.periodEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.</p>
            ) : (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2">Date</th>
                    <th className="py-2">Invoice</th>
                    <th className="py-2">Amount</th>
                    <th className="py-2">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2">{inv.createdAt.toLocaleDateString("en-GB")}</td>
                      <td className="py-2">{inv.number ?? inv.id}</td>
                      <td className="py-2 tabular-nums">{formatPence(inv.amountDue, inv.currency)}</td>
                      <td className="py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${inv.status === "paid" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : inv.status === "open" ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-slate-100 text-slate-600 ring-slate-200"}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {inv.url && (
                          <a href={inv.url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-900">
                            View
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}
