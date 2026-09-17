import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { formatMinor, formatRate, fromMonthly, NUMBER_TYPES, NUMBER_TYPE_LABELS, surchargePercent } from "@/lib/billing/pricing";
import { createClient } from "@/lib/supabase/server";
import { resolveAgency } from "@/lib/tenancy/resolve";
import { SearchWidget } from "./storefront/search-widget";

export const dynamic = "force-dynamic";

/**
 * The agency-branded storefront. One page per hostname: the agency is
 * resolved from the Host, so every agency's customers see their brand.
 */
export default async function StorefrontPage() {
  const agency = await resolveAgency();
  if (!agency) return <NotConfigured />;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/app");

  // Pricing is optional on the page: a missing/unmigrated plans table or a
  // DB blip must never take the storefront down.
  const planRows = await db.query.plans
    .findMany({ where: and(eq(plans.agencyId, agency.id), eq(plans.active, true)), orderBy: [asc(plans.hostingMonthlyPence)] })
    .catch((e) => {
      console.warn("[storefront] plans unavailable", e instanceof Error ? e.message : e);
      return [];
    });
  const accent = agency.brandPrimaryColor ?? "#0f172a";
  const surcharges = [...new Set(planRows.filter((p) => p.surchargeBps > 0).map((p) => surchargePercent(p.surchargeBps)))];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900" style={{ ["--accent" as string]: accent }}>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            {agency.brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agency.brandLogoUrl} alt={agency.name} className="h-9 w-9 rounded-md object-contain" />
            ) : (
              <div className="h-9 w-9 rounded-md" style={{ background: accent }} aria-hidden />
            )}
            <span className="font-semibold">{agency.name}</span>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <a href="#pricing" className="hidden text-slate-600 hover:text-slate-900 sm:inline">
              Pricing
            </a>
            <a href="#how" className="hidden text-slate-600 hover:text-slate-900 sm:inline">
              How it works
            </a>
            <Link href="/login" className="btn-secondary">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-12 sm:pt-20">
          <div className="grid items-start gap-10 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide" style={{ color: accent }}>
                UK business phone numbers
              </p>
              <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-5xl">Your business number, answered every time.</h1>
              <p className="mt-5 max-w-xl text-lg text-slate-600">
                Pick a local, national, freephone or mobile number. Then decide who answers it: you, an AI receptionist, or you first and the AI only
                when you can&apos;t.
              </p>
              <ul className="mt-6 space-y-2 text-sm text-slate-700">
                <li className="flex gap-2">
                  <Tick accent={accent} /> Rings your mobile, your landline or your browser, all at once
                </li>
                <li className="flex gap-2">
                  <Tick accent={accent} /> AI receptionist takes over when you&apos;re busy or after hours
                </li>
                <li className="flex gap-2">
                  <Tick accent={accent} /> Every call logged, voicemails transcribed
                </li>
                <li className="flex gap-2">
                  <Tick accent={accent} /> No contract, cancel any month
                </li>
              </ul>
            </div>
            <div>
              <SearchWidget accent={accent} />
              <p className="mt-3 text-center text-xs text-slate-500">Live availability. Nothing is reserved until you sign up.</p>
            </div>
          </div>
        </section>

        <section id="how" className="border-y border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-2xl font-semibold">How it works</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-4">
              {[
                ["Choose a number", "Search live UK inventory by area code or type and pick the one you like."],
                ["Verify with Ofcom", "UK rules mean every number is registered to its owner. Enter your business details once; they cover every number you buy afterwards, and approval is usually within 24 hours."],
                ["Decide who answers", "You, the AI receptionist, or both: ring you first and hand over to the AI when you can't pick up. Set hours, holidays and a keypad menu."],
                ["Go live", "The number activates itself on approval. Answer on your phone or in the browser, and read every call in your log."],
              ].map(([title, body], i) => (
                <li key={title} className="rounded-xl border border-slate-200 p-5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: accent }}>
                    {i + 1}
                  </div>
                  <h3 className="mt-3 font-semibold">{title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="text-2xl font-semibold">Simple monthly pricing</h2>
          <p className="mt-2 max-w-2xl text-slate-600">
            Twilio&apos;s number charge, a hosting charge per number, and the minutes you use, each shown on your invoice and billed automatically each month. The AI receptionist is a separate
            add-on from {agency.name}.
          </p>
          {planRows.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
              Pricing is being finalised. <Link href="/signup" className="underline">Get started</Link> and {agency.name} will confirm your plan.
            </div>
          ) : (
            <div className="mt-8 grid gap-5 md:grid-cols-3">
              {planRows.map((p) => (
                <div key={p.id} className={`rounded-2xl bg-white p-6 shadow-sm ring-1 ${p.isDefault ? "ring-2" : "ring-slate-200"}`} style={p.isDefault ? { ["--tw-ring-color" as string]: accent } : undefined}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{p.name}</h3>
                    {p.isDefault && (
                      <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: accent }}>
                        Popular
                      </span>
                    )}
                  </div>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-sm text-slate-500">from</span>
                    <span className="text-4xl font-semibold">{formatMinor(fromMonthly(p), p.currency)}</span>
                    <span className="text-sm text-slate-500">/ number / month</span>
                  </div>
                  {p.description && <p className="mt-2 text-sm text-slate-600">{p.description}</p>}
                  <ul className="mt-4 space-y-1.5 text-sm text-slate-700">
                    <li>Hosting {formatMinor(p.hostingMonthlyPence, p.currency)} per number per month</li>
                    <li>
                      Twilio number charge: {NUMBER_TYPES.map((t) => `${NUMBER_TYPE_LABELS[t]} ${formatMinor(p.carrierMonthlyPence[t] ?? 0, p.currency)}`).join(", ")} per month
                    </li>
                    {p.usageMode === "passthrough" ? (
                      <li>Calls at exactly what Twilio charges, nothing added</li>
                    ) : (
                      <>
                        <li>
                          {p.includedMinutes > 0 ? `${p.includedMinutes} minutes included each month, then ` : "Twilio usage "}
                          {formatRate(p.perMinutePence, p.currency)} per minute
                        </li>
                        <li>0800 inbound at {formatRate(p.freephoneInboundPence, p.currency)} per minute</li>
                      </>
                    )}
                    <li>{p.voicemailTranscribePence > 0 ? `Voicemail transcription ${formatRate(p.voicemailTranscribePence, p.currency)} each` : "Voicemail transcription included"}</li>
                    {p.surchargeBps > 0 && <li>{surchargePercent(p.surchargeBps)}% card processing surcharge</li>}
                  </ul>
                  <Link href={`/signup?plan=${p.id}`} className="btn-primary mt-6 w-full" style={{ background: accent }}>
                    Get started
                  </Link>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-slate-500">
            Prices exclude VAT. Twilio&apos;s number and usage charges appear as their own lines on your invoice
            {surcharges.length > 0 ? `, and a ${surcharges.join("% / ")}% card processing surcharge is added to the total` : ""}. There is no setup fee.
          </p>
        </section>

        <section className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-3xl px-6 py-14">
            <h2 className="text-2xl font-semibold">Questions</h2>
            <dl className="mt-6 divide-y divide-slate-200">
              {[
                ["How long does Ofcom verification take?", "Usually under 24 hours, occasionally a few days. Your number is held for you meanwhile and goes live automatically on approval. A second number of the same type is instant."],
                ["What details do I need for verification?", "For a limited company: your business name, Companies House number, a UK business address and an authorised contact. Sole traders can register as an individual with proof of identity."],
                ["What happens after hours?", "Whatever you choose. Most businesses let the AI receptionist answer out of hours and take a message, and ring their own phones during the day with the AI as backup."],
                ["Can I answer on my existing phone?", "Yes. Calls are forwarded to any UK mobile or landline, and you can add a browser softphone too. Your phone asks you to press 1 so its own voicemail never swallows a call."],
                ["Can I keep my number if I leave?", "Porting your number in or out is coming in a later release. Until then, numbers stay with this service; you can cancel any month and the number is released at the end of the paid period."],
                ["Is the AI receptionist included?", `It is a separate add-on from ${agency.name}, billed on its own with its own minutes. You can run a number without it.`],
              ].map(([q, a]) => (
                <div key={q} className="py-5">
                  <dt className="font-medium">{q}</dt>
                  <dd className="mt-1 text-sm text-slate-600">{a}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-8 rounded-2xl p-6 text-center text-white" style={{ background: accent }}>
              <h3 className="text-lg font-semibold">Ready for a number that&apos;s always answered?</h3>
              <Link href="/signup" className="mt-4 inline-flex items-center justify-center rounded-md bg-white px-5 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-100">
                Get started
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} {agency.name}. UK numbers subject to Ofcom registration.</span>
          <span className="flex gap-4">
            <Link href="/login" className="hover:text-slate-900">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-slate-900">
              Sign up
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

function Tick({ accent }: { accent: string }) {
  return (
    <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="10" fill={accent} opacity="0.15" />
      <path d="M6 10.5l2.5 2.5L14 7.5" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NotConfigured() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold text-slate-900">This domain is not set up</h1>
        <p className="mt-2 text-sm text-slate-600">No workspace is configured for this address yet. If you run an agency, add the hostname under Settings once you&apos;re signed in.</p>
      </div>
    </main>
  );
}
