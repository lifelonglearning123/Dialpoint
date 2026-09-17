"use client";

import { useState, useTransition } from "react";
import {
  asCurrency,
  CURRENCIES,
  currencySymbol,
  floorFor,
  formatMinor,
  formatRate,
  NUMBER_TYPES,
  NUMBER_TYPE_LABELS,
  surchargePercent,
  type CarrierMonthly,
  type UsageMode,
} from "@/lib/billing/pricing";
import { publishPlanAction, savePlan, type PlanResult } from "./actions";

export type PlanRow = {
  id: string;
  name: string;
  description: string | null;
  currency: string;
  carrierMonthlyPence: CarrierMonthly;
  hostingMonthlyPence: number;
  includedMinutes: number;
  perMinutePence: number;
  freephoneInboundPence: number;
  voicemailTranscribePence: number;
  surchargeBps: number;
  usageMode: UsageMode;
  publishedAt: Date | null;
};

const CARRIER_FIELD: Record<(typeof NUMBER_TYPES)[number], string> = { local: "carrierLocal", national: "carrierNational", tollfree: "carrierTollfree", mobile: "carrierMobile" };

const toMajor = (minor: number) => (minor / 100).toFixed(2);

export function PlanForm({ plan, stripeConnected, defaultCurrency = "GBP", onDone }: { plan?: PlanRow; stripeConnected: boolean; defaultCurrency?: string; onDone?: () => void }) {
  const [result, setResult] = useState<PlanResult | null>(null);
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<UsageMode>(plan?.usageMode ?? "flat");
  const [currency, setCurrency] = useState(asCurrency(plan?.currency ?? defaultCurrency));
  const floor = floorFor(currency);
  const sym = currencySymbol(currency);
  const locked = !!plan?.publishedAt;
  const passthrough = mode === "passthrough";
  // Twilio bills calls in GBP, so a pass-through plan is GBP by definition.
  const currencyFixed = locked || passthrough;

  const chooseMode = (m: UsageMode) => {
    setMode(m);
    if (m === "passthrough") setCurrency("GBP");
  };

  // New plans start at cost for the pass-through lines and a modest hosting
  // charge; every value is the agency's to change.
  const d = plan ?? {
    carrierMonthlyPence: floor.carrierMonthly,
    hostingMonthlyPence: 500,
    includedMinutes: 0,
    perMinutePence: floor.perMinute,
    freephoneInboundPence: floor.freephoneInbound,
    voicemailTranscribePence: 0,
    surchargeBps: 300,
  };
  const minorUnit = formatRate(1, currency).replace(/^1/, "");

  const submit = (fd: FormData) => {
    setResult(null);
    start(async () => {
      const r = await savePlan(fd);
      setResult(r);
      if (r.ok) onDone?.();
    });
  };

  const publish = () => {
    if (!plan) return;
    setResult(null);
    const fd = new FormData();
    fd.set("id", plan.id);
    start(async () => setResult(await publishPlanAction(fd)));
  };

  return (
    <form action={submit} className="space-y-6">
      {plan && <input type="hidden" name="id" value={plan.id} />}
      <input type="hidden" name="usageMode" value={mode} />
      {result && !result.ok && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div>{result.error}</div>
          {result.problems && (
            <ul className="mt-1 list-disc pl-5">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result?.ok && <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-700">Saved.</div>}

      <div className="grid gap-4 md:grid-cols-3">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Plan name</span>
          <input name="name" defaultValue={plan?.name ?? ""} required className="input" placeholder="Starter" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">One-line description (shown on the storefront)</span>
          <input name="description" defaultValue={plan?.description ?? ""} className="input" placeholder="Everything a small team needs" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Currency</span>
          {currencyFixed && <input type="hidden" name="currency" value={currency} />}
          <select name={currencyFixed ? undefined : "currency"} value={currency} disabled={currencyFixed} onChange={(e) => setCurrency(asCurrency(e.target.value))} className="input">
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c} ({currencySymbol(c)})
              </option>
            ))}
          </select>
          <span className="block text-xs text-slate-500">
            {locked ? "Fixed once published: Stripe prices are single-currency." : passthrough ? "GBP: Twilio bills call charges in GBP and they are passed on unchanged." : "Every amount below is in this currency. Fixed once published."}
          </span>
        </label>
      </div>

      {/* key: a currency change on a new plan resets the defaults to that currency's floor */}
      <div key={plan ? plan.id : currency} className="space-y-6">
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">1. Twilio monthly number charge ({sym} per number per month)</legend>
          <p className="text-xs text-slate-500">Shown on the customer&apos;s invoice as its own line per number type. The floor is Twilio&apos;s own monthly cost.</p>
          <div className="grid gap-4 md:grid-cols-4">
            {NUMBER_TYPES.map((t) => (
              <label key={t} className="space-y-1.5">
                <span className="text-sm font-medium">{NUMBER_TYPE_LABELS[t]}</span>
                <input name={CARRIER_FIELD[t]} type="number" step="0.01" min="0" defaultValue={toMajor(d.carrierMonthlyPence[t] ?? 0)} required className="input" />
                <span className="block text-xs text-slate-500">Floor {formatMinor(floor.carrierMonthly[t], currency)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">2. Monthly hosting charge ({sym} per number per month)</legend>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Hosting per number</span>
              <input name="hostingMonthly" type="number" step="0.01" min="0" defaultValue={toMajor(d.hostingMonthlyPence)} required className="input" />
              <span className="block text-xs text-slate-500">Your margin. Charged once per active number (at least one while subscribed).</span>
            </label>
            {!passthrough && (
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Included minutes per month</span>
                <input name="includedMinutes" type="number" min="0" defaultValue={d.includedMinutes} required className="input" />
                <span className="block text-xs text-slate-500">
                  Pooled across forwarded, inbound and browser minutes. Each costs about {formatRate(floor.perMinute, currency)} of carrier time, so hosting must cover them. 0 = pay per minute
                  from the first minute.
                </span>
              </label>
            )}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">3. Twilio usage charge</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <label className={`cursor-pointer rounded-lg border p-4 ${passthrough ? "border-slate-900 ring-2 ring-slate-200" : "border-slate-200 hover:border-slate-400"}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="usageModeChoice" checked={passthrough} onChange={() => chooseMode("passthrough")} />
                <span className="font-medium">Exact pass-through</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Each call is billed at what Twilio charged for it, to the hundredth of a penny: mobile, landline, browser and 0800 calls all price themselves. Nothing is added except the surcharge
                below. A call is held until Twilio has priced it, so what the customer sees is Twilio&apos;s figure.
              </p>
            </label>
            <label className={`cursor-pointer rounded-lg border p-4 ${!passthrough ? "border-slate-900 ring-2 ring-slate-200" : "border-slate-200 hover:border-slate-400"}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="usageModeChoice" checked={!passthrough} onChange={() => chooseMode("flat")} />
                <span className="font-medium">Flat rate per minute</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">One price per minute whatever the destination, with an optional allowance. Simpler to quote; your margin varies by where calls are answered.</p>
            </label>
          </div>
          {!passthrough && (
            <div className="grid gap-4 md:grid-cols-3">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Per minute ({minorUnit})</span>
                <input name="perMinute" type="number" min="0" defaultValue={d.perMinutePence} required className="input" />
                <span className="block text-xs text-slate-500">Forwarded, inbound and browser minutes after any allowance. Floor {formatRate(floor.perMinute, currency)}.</span>
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">0800 inbound per minute ({minorUnit})</span>
                <input name="freephoneInbound" type="number" min="0" defaultValue={d.freephoneInboundPence} required className="input" />
                <span className="block text-xs text-slate-500">Always billed, no allowance. Floor {formatRate(floor.freephoneInbound, currency)} (Twilio 7.98p).</span>
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Voicemail transcription (each, 0 = included)</span>
                <input name="voicemailTranscribe" type="number" min="0" defaultValue={d.voicemailTranscribePence} required className="input" />
              </label>
            </div>
          )}
          {passthrough && (
            <div className="grid gap-4 md:grid-cols-3">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Voicemail transcription (p each, 0 = included)</span>
                <input name="voicemailTranscribe" type="number" min="0" defaultValue={d.voicemailTranscribePence} required className="input" />
                <span className="block text-xs text-slate-500">Not a Twilio charge, so it is priced here.</span>
              </label>
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Card processing surcharge</legend>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Surcharge (%)</span>
              <input name="surchargePercent" type="number" step="0.25" min="0" max="20" defaultValue={surchargePercent(d.surchargeBps)} required className="input" />
              <span className="block text-xs text-slate-500">Added to every invoice total as a separate &quot;Card processing surcharge&quot; line. 0 to switch it off.</span>
            </label>
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? "Saving…" : plan ? "Save changes" : "Create plan"}
        </button>
        {plan && (
          <button type="button" disabled={pending || !stripeConnected} onClick={publish} className="btn-secondary" title={stripeConnected ? "" : "Connect Stripe in the Signal dashboard first"}>
            {plan.publishedAt ? "Re-publish prices to Stripe" : "Publish to Stripe"}
          </button>
        )}
        {plan?.publishedAt && <span className="text-xs text-slate-500">Published {new Date(plan.publishedAt).toLocaleDateString("en-GB")}. Existing customers keep their current prices.</span>}
      </div>
    </form>
  );
}
