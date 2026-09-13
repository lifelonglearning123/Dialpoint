"use client";

import { useState, useTransition } from "react";
import { publishPlanAction, savePlan, type PlanResult } from "./actions";

type PlanRow = {
  id: string;
  name: string;
  description: string | null;
  numberMonthlyPence: number;
  includedMinutes: number;
  perMinutePence: number;
  freephoneInboundPence: number;
  voicemailTranscribePence: number;
  publishedAt: Date | null;
};

export function PlanForm({ plan, stripeConnected, onDone }: { plan?: PlanRow; stripeConnected: boolean; onDone?: () => void }) {
  const [result, setResult] = useState<PlanResult | null>(null);
  const [pending, start] = useTransition();

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
    <form action={submit} className="space-y-4">
      {plan && <input type="hidden" name="id" value={plan.id} />}
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
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Plan name</span>
          <input name="name" defaultValue={plan?.name ?? ""} required className="input" placeholder="Starter" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">One-line description (shown on the storefront)</span>
          <input name="description" defaultValue={plan?.description ?? ""} className="input" placeholder="Everything a small team needs" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Monthly fee per number (£)</span>
          <input name="numberMonthly" type="number" step="0.01" min="0" defaultValue={plan ? (plan.numberMonthlyPence / 100).toFixed(2) : "9.00"} required className="input" />
          <span className="block text-xs text-slate-500">Wholesale floor £4.00 (Twilio charges up to £3.50 per number).</span>
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Included minutes per month</span>
          <input name="includedMinutes" type="number" min="0" defaultValue={plan?.includedMinutes ?? 100} required className="input" />
          <span className="block text-xs text-slate-500">Pooled across forwarded, inbound and browser minutes. Each costs ~4p of carrier time, so the fee must cover them.</span>
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Per extra minute (pence)</span>
          <input name="perMinute" type="number" min="0" defaultValue={plan?.perMinutePence ?? 5} required className="input" />
          <span className="block text-xs text-slate-500">Floor 4p.</span>
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">0800 inbound per minute (pence)</span>
          <input name="freephoneInbound" type="number" min="0" defaultValue={plan?.freephoneInboundPence ?? 12} required className="input" />
          <span className="block text-xs text-slate-500">Always billed, no allowance. Floor 9p (Twilio 7.98p).</span>
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Voicemail transcription (pence each, 0 = included)</span>
          <input name="voicemailTranscribe" type="number" min="0" defaultValue={plan?.voicemailTranscribePence ?? 0} required className="input" />
        </label>
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
