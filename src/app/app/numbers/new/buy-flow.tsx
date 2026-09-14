"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { formatUk, typeLabel } from "@/lib/format";
import type { AvailableNumber, NumberType } from "@/lib/twilio/numbers";
import { FIELD_LABELS } from "@/lib/twilio/business-labels";
import type { EndUserType, EvaluationFailure } from "@/lib/twilio/regulatory";
import { reserveNumberAction, searchNumbersAction, type ReserveOutcome } from "../actions";

type Step = "type" | "results" | "card" | "register" | "verifying" | "active";

const TYPE_OPTIONS: Array<{ value: NumberType; title: string; blurb: string; monthly: string }> = [
  { value: "local", title: "Local (01 / 02)", blurb: "A number for your town or city. Needs a UK business address.", monthly: "from £3.50/mo carrier cost" },
  { value: "national", title: "National (03)", blurb: "Non-geographic, charged like a landline for callers.", monthly: "from £3.50/mo carrier cost" },
  { value: "tollfree", title: "Freephone (0800)", blurb: "Free for callers; you pay per inbound minute.", monthly: "from £2.70/mo carrier cost" },
  { value: "mobile", title: "Mobile (07)", blurb: "Looks like a mobile, rings wherever you route it.", monthly: "from £2.50/mo carrier cost" },
];

export type ResumeState = {
  numberId: string;
  chosen: AvailableNumber;
  endUserType: EndUserType;
  active: boolean;
  needsProfile?: boolean;
  registration?: ReserveOutcome["registration"];
  /** Card step was cancelled at Stripe. */
  cancelled?: boolean;
  error?: string;
};

export function BuyFlow(props: {
  clientName: string;
  contactEmail: string;
  approvedTypes: string[];
  pendingTypes: string[];
  hasProfile: boolean;
  /** From the storefront: preselect this type and search for this number first. */
  initialType?: NumberType;
  initialContains?: string;
  /** Present when the browser has just returned from Stripe Checkout (Phase 3). */
  resume?: ResumeState;
}) {
  const r0 = props.resume;
  const initialStep = (r: ResumeState | undefined): Step => {
    if (!r) return "type";
    if (r.cancelled || r.error) return "card";
    if (r.active) return "active";
    if (r.registration?.submitted) return "verifying";
    return "register";
  };
  const [step, setStep] = useState<Step>(initialStep(r0));
  const [type, setType] = useState<NumberType>(r0?.chosen.type ?? props.initialType ?? "local");
  const [results, setResults] = useState<AvailableNumber[]>([]);
  const [chosen, setChosen] = useState<AvailableNumber | null>(r0?.chosen ?? null);
  const [numberId, setNumberId] = useState<string | null>(r0?.numberId ?? null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [needsProfile, setNeedsProfile] = useState<boolean>(r0?.needsProfile ?? false);
  const [failures, setFailures] = useState<EvaluationFailure[]>(r0?.registration?.failures ?? []);
  const [error, setError] = useState<string | null>(r0?.error ?? (r0?.cancelled ? "Payment was cancelled. Add a card to continue." : null));
  const [pending, start] = useTransition();

  const search = (fd: FormData) => {
    setError(null);
    fd.set("type", type);
    start(async () => {
      const r = await searchNumbersAction(fd);
      if (!r.ok) return setError(r.error);
      setResults(r.data);
      setStep("results");
    });
  };

  // Storefront hand-off: run the search for the chosen number once on mount.
  const autoSearched = useRef(false);
  useEffect(() => {
    if (autoSearched.current || !props.initialContains) return;
    autoSearched.current = true;
    const fd = new FormData();
    fd.set("contains", props.initialContains);
    search(fd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Where the reserve outcome sends the customer next. */
  const applyOutcome = (o: ReserveOutcome, followCheckout: boolean) => {
    setNumberId(o.numberId);
    if (o.checkoutUrl) {
      setCheckoutUrl(o.checkoutUrl);
      if (followCheckout) return window.location.assign(o.checkoutUrl);
      return setStep("card");
    }
    if (o.active) return setStep("active");
    if (o.needsProfile) {
      setNeedsProfile(true);
      return setStep("register");
    }
    setNeedsProfile(false);
    setFailures(o.registration?.failures ?? []);
    setStep(o.registration?.submitted ? "verifying" : "register");
  };

  const reserve = (n: AvailableNumber) => {
    setError(null);
    const fd = new FormData();
    fd.set("type", type);
    fd.set("e164", n.e164);
    fd.set("locality", n.locality ?? "");
    start(async () => {
      const r = await reserveNumberAction(fd);
      if (!r.ok) return setError(r.error);
      setChosen(n);
      applyOutcome(r.data, false);
    });
  };

  const retryCheckout = () => {
    if (!chosen) return;
    setError(null);
    const fd = new FormData();
    fd.set("type", type);
    fd.set("e164", chosen.e164);
    fd.set("locality", chosen.locality ?? "");
    start(async () => {
      const r = await reserveNumberAction(fd);
      if (!r.ok) return setError(r.error);
      applyOutcome(r.data, true);
    });
  };

  const businessUrl = `/app/business?return=${encodeURIComponent(`/app/numbers/new?numberId=${numberId ?? ""}`)}`;

  return (
    <div className="space-y-6">
      <Steps current={step} />
      {error && <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {step === "type" && (
        <div className="card space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            {TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setType(o.value)}
                className={`rounded-lg border p-4 text-left transition ${type === o.value ? "border-slate-900 ring-2 ring-slate-200" : "border-slate-200 hover:border-slate-400"}`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{o.title}</div>
                  {props.approvedTypes.includes(o.value) && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200">registered</span>}
                  {props.pendingTypes.includes(o.value) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-200">verifying</span>}
                </div>
                <div className="mt-1 text-sm text-slate-600">{o.blurb}</div>
                <div className="mt-2 text-xs text-slate-500">{o.monthly}</div>
              </button>
            ))}
          </div>
          <form action={search} className="flex flex-wrap items-end gap-3">
            {type === "local" && (
              <>
                <label className="block min-w-48 flex-1 space-y-1.5">
                  <span className="text-sm font-medium">Area code or town</span>
                  <input name="contains" placeholder="020, 0161, 01865…" className="input" />
                </label>
                <label className="block min-w-48 flex-1 space-y-1.5">
                  <span className="text-sm font-medium">Locality (optional)</span>
                  <input name="locality" placeholder="London" className="input" />
                </label>
              </>
            )}
            {type !== "local" && (
              <label className="block min-w-48 flex-1 space-y-1.5">
                <span className="text-sm font-medium">Digits you&apos;d like it to contain (optional)</span>
                <input name="contains" placeholder={type === "national" ? "0330…" : type === "tollfree" ? "0800…" : "07…"} className="input" />
              </label>
            )}
            <button type="submit" disabled={pending} className="btn-primary">
              {pending ? "Searching…" : "Find numbers"}
            </button>
          </form>
        </div>
      )}

      {step === "results" && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Available {typeLabel(type).toLowerCase()} numbers</h2>
            <button type="button" onClick={() => setStep("type")} className="text-sm text-slate-500 hover:text-slate-900">
              Change type or search
            </button>
          </div>
          {results.length === 0 ? (
            <p className="text-sm text-slate-600">Nothing matched. Try a broader area code.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {results.map((n) => (
                <li key={n.e164} className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-medium tabular-nums">{formatUk(n.e164)}</div>
                    {n.locality && <div className="text-xs text-slate-500">{n.locality}</div>}
                  </div>
                  <button type="button" disabled={pending} onClick={() => reserve(n)} className="btn-secondary">
                    {pending ? "…" : props.approvedTypes.includes(type) ? "Buy this number" : "Reserve this number"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!props.approvedTypes.includes(type) && (
            <p className="text-xs text-slate-500">
              Reserving holds the number in your account. Because this is your first {typeLabel(type).toLowerCase()} number, Ofcom rules mean it is registered to your business first; we use the
              details you saved {props.hasProfile ? "under Business" : "once under Business"} and it goes live on approval, usually within 24 hours.
            </p>
          )}
        </div>
      )}

      {step === "card" && chosen && (
        <div className="card space-y-4">
          <h2 className="font-semibold">Add a card for {formatUk(chosen.e164)}</h2>
          <p className="text-sm text-slate-600">
            Numbers are billed monthly: a fixed fee per number plus the minutes you use, charged automatically to a card you save once. The first
            invoice is raised at the end of the month the number goes live.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            <li>Fixed monthly fee per active number.</li>
            <li>Usage: forwarded, inbound and browser minutes over your allowance, plus 0800 inbound minutes.</li>
            <li>Change your card or view invoices any time under Billing. Cancel any month.</li>
          </ul>
          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={() => setStep("results")} className="text-sm text-slate-500 hover:text-slate-900">
              Back
            </button>
            {checkoutUrl ? (
              <a href={checkoutUrl} className="btn-primary">
                Continue to secure payment
              </a>
            ) : (
              <button type="button" disabled={pending} onClick={retryCheckout} className="btn-primary">
                {pending ? "One moment…" : "Continue to secure payment"}
              </button>
            )}
          </div>
        </div>
      )}

      {step === "register" && chosen && (
        <div className="card space-y-4">
          {needsProfile ? (
            <>
              <h2 className="font-semibold">Tell us about your business once</h2>
              <p className="text-sm text-slate-600">
                <strong className="tabular-nums text-slate-900">{formatUk(chosen.e164)}</strong> is reserved for you. UK numbers must be registered to their owner, so we need your business&apos;s
                legal details and address. You enter them once; every number you buy afterwards uses them.
              </p>
              <div className="flex gap-3 pt-2">
                <Link href={businessUrl} className="btn-primary">
                  Add business details
                </Link>
                <button type="button" onClick={() => setStep("results")} className="btn-secondary">
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="font-semibold">Ofcom needs a little more before this type can be registered</h2>
              <p className="text-sm text-slate-600">
                <strong className="tabular-nums text-slate-900">{formatUk(chosen.e164)}</strong> is reserved. We tried to register {typeLabel(type).toLowerCase()} numbers from your saved business
                details and Twilio flagged the following:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
                {failures.map((f, i) => (
                  <li key={i}>
                    <strong>{FIELD_LABELS[f.field] ?? f.label}</strong>: {f.reason}
                  </li>
                ))}
                {failures.length === 0 && <li>The registration could not be submitted. Check your details and register the type under Business.</li>}
              </ul>
              <div className="flex gap-3 pt-2">
                <Link href={businessUrl} className="btn-primary">
                  Fix business details
                </Link>
                <Link href="/app/numbers" className="btn-secondary">
                  Back to numbers
                </Link>
              </div>
            </>
          )}
        </div>
      )}

      {step === "verifying" && chosen && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Registration submitted</h2>
          <p className="text-sm text-slate-600">
            <strong className="tabular-nums text-slate-900">{formatUk(chosen.e164)}</strong> is reserved for you. Your business details are being verified against Ofcom&apos;s requirements for{" "}
            {typeLabel(type).toLowerCase()} numbers. This usually completes within 24 hours, sometimes a few days, and only happens once per number type.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            <li>The number is bought and goes live automatically the moment the registration is approved.</li>
            <li>You&apos;ll see it flip from &ldquo;reserved&rdquo; to &ldquo;active&rdquo; on the Numbers page. Set up its routing in the meantime.</li>
            <li>If Twilio needs anything, they email the contact address you gave.</li>
          </ul>
          <div className="flex gap-3 pt-2">
            {numberId && (
              <Link href={`/app/routing/${numberId}`} className="btn-primary">
                Set up routing now
              </Link>
            )}
            <Link href="/app/numbers" className="btn-secondary">
              Back to numbers
            </Link>
          </div>
        </div>
      )}

      {step === "active" && chosen && (
        <div className="card space-y-3">
          <h2 className="font-semibold">{formatUk(chosen.e164)} is live</h2>
          <p className="text-sm text-slate-600">Your existing Ofcom registration covered it, so the number was bought straight away. Calls will follow whatever routing you set next.</p>
          <div className="flex gap-3 pt-2">
            {numberId && (
              <Link href={`/app/routing/${numberId}`} className="btn-primary">
                Set up routing
              </Link>
            )}
            <Link href="/app/numbers" className="btn-secondary">
              Back to numbers
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const items: Array<[Step[], string]> = [
    [["type", "results"], "1. Choose a number"],
    [["card"], "2. Card on file"],
    [["register"], "3. Register the owner"],
    [["verifying", "active"], "4. Go live"],
  ];
  return (
    <ol className="flex gap-6 text-sm">
      {items.map(([steps, label]) => (
        <li key={label} className={steps.includes(current) ? "font-semibold text-slate-900" : "text-slate-400"}>
          {label}
        </li>
      ))}
    </ol>
  );
}
