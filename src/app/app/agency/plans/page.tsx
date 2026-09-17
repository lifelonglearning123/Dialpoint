import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { agencies } from "@/db/shared";
import { isAgency, requireSession } from "@/lib/auth";
import { floorFor, formatMinor, formatRate, fromMonthly, NUMBER_TYPES, NUMBER_TYPE_LABELS, surchargePercent, TWILIO_GBP } from "@/lib/billing/pricing";
import { stripeConfigured } from "@/lib/billing/stripe";
import { PlanForm } from "./plan-form";
import { setDefaultPlan, togglePlanActive } from "./actions";

export const metadata = { title: "Plans" };
export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const session = await requireSession();
  if (!isAgency(session.role)) redirect("/app");

  const [agency] = await db.select({ stripeAccountId: agencies.stripeAccountId, chargesEnabled: agencies.stripeChargesEnabled, feeBps: agencies.platformFeeBps }).from(agencies).where(eq(agencies.id, session.agencyId)).limit(1);
  const rows = await db.query.plans.findMany({ where: eq(plans.agencyId, session.agencyId), orderBy: [desc(plans.isDefault), desc(plans.createdAt)] });
  const stripeConnected = !!agency?.stripeAccountId && stripeConfigured();
  const gbp = floorFor("GBP");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Plans</h1>
        <p className="text-sm text-slate-500">
          What {session.agency.name}&apos;s customers pay. Each plan is three invoice lines: Twilio&apos;s monthly number charge (per number type), your monthly hosting charge, and Twilio usage per
          minute, plus a card processing surcharge on the total. The floor is Twilio&apos;s cost: {formatMinor(TWILIO_GBP.carrierMonthly.local)} local, {formatMinor(TWILIO_GBP.carrierMonthly.mobile)}{" "}
          mobile, {formatMinor(TWILIO_GBP.carrierMonthly.tollfree)} 0800 per month; {formatRate(gbp.perMinute)} per minute; {formatRate(gbp.freephoneInbound)} per 0800 minute.
        </p>
      </div>

      {!agency?.stripeAccountId ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <strong>Stripe is not connected for this agency.</strong> Customers cannot be charged until it is. Connect Stripe from the Signal dashboard (Settings → Billing); the same
          connected account is used here, and the platform fee is {((agency?.feeBps ?? 0) / 100).toFixed(1)}% per invoice.
        </div>
      ) : !agency.chargesEnabled ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          Stripe is connected but charges are not enabled yet. Finish the Stripe onboarding before publishing plans.
        </div>
      ) : null}

      {rows.length > 0 && (
        <section className="space-y-4">
          {rows.map((p) => {
            const floor = floorFor(p.currency);
            const hostingMargin = p.hostingMonthlyPence - p.includedMinutes * floor.perMinute;
            return (
              <div key={p.id} className="card">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold">{p.name}</h2>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">{p.currency}</span>
                      {p.isDefault && <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs text-white">default</span>}
                      {!p.active && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">inactive</span>}
                      <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${p.publishedAt ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"}`}>
                        {p.publishedAt ? "on Stripe" : "not published"}
                      </span>
                    </div>
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-[auto_1fr]">
                      <dt className="font-medium text-slate-700">Twilio number</dt>
                      <dd>{NUMBER_TYPES.map((t) => `${NUMBER_TYPE_LABELS[t]} ${formatMinor(p.carrierMonthlyPence[t] ?? 0, p.currency)}`).join(" · ")} per month</dd>
                      <dt className="font-medium text-slate-700">Hosting</dt>
                      <dd>
                        {formatMinor(p.hostingMonthlyPence, p.currency)} per number per month{p.includedMinutes > 0 ? ` · ${p.includedMinutes} min included` : ""}
                      </dd>
                      <dt className="font-medium text-slate-700">Twilio usage</dt>
                      <dd>
                        {formatRate(p.perMinutePence, p.currency)}/min · 0800 inbound {formatRate(p.freephoneInboundPence, p.currency)}/min
                        {p.voicemailTranscribePence ? ` · voicemail ${formatRate(p.voicemailTranscribePence, p.currency)} each` : ""}
                      </dd>
                      <dt className="font-medium text-slate-700">Surcharge</dt>
                      <dd>{p.surchargeBps > 0 ? `${surchargePercent(p.surchargeBps)}% card processing on every invoice` : "none"}</dd>
                    </dl>
                    <div className="mt-2 text-xs text-slate-500">
                      From {formatMinor(fromMonthly(p), p.currency)} per number per month before usage. Hosting margin {formatMinor(hostingMargin, p.currency)} per number if every included minute is used.
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {!p.isDefault && p.active && (
                      <form action={setDefaultPlan}>
                        <input type="hidden" name="id" value={p.id} />
                        <button className="btn-secondary" type="submit">
                          Make default
                        </button>
                      </form>
                    )}
                    <form action={togglePlanActive}>
                      <input type="hidden" name="id" value={p.id} />
                      <button className="btn-secondary" type="submit">
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                  </div>
                </div>
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm text-slate-600 hover:text-slate-900">Edit prices</summary>
                  <div className="mt-4">
                    <PlanForm plan={p} stripeConnected={stripeConnected} defaultCurrency={session.agency.currency} />
                  </div>
                </details>
              </div>
            );
          })}
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold">{rows.length === 0 ? "Create your first plan" : "Add another plan"}</h2>
        <p className="mt-1 text-sm text-slate-600">New customers subscribe to the default plan when they buy their first number. Publish it to Stripe before the first sale.</p>
        <div className="mt-4">
          <PlanForm stripeConnected={stripeConnected} defaultCurrency={session.agency.currency} />
        </div>
      </section>
    </div>
  );
}
