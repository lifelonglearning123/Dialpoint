"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { formatUk, typeLabel } from "@/lib/format";
import type { AvailableNumber, NumberType } from "@/lib/twilio/numbers";
import type { EndUserType, EvaluationFailure, RegulationSpec } from "@/lib/twilio/regulatory";
import { regulationSpecAction, reserveNumberAction, searchNumbersAction, submitBundleAction, submitKycAction } from "../actions";

type Step = "type" | "results" | "card" | "kyc" | "verifying" | "active";

const TYPE_OPTIONS: Array<{ value: NumberType; title: string; blurb: string; monthly: string }> = [
  { value: "local", title: "Local (01 / 02)", blurb: "A number for your town or city. Needs a UK business address.", monthly: "from £3.50/mo carrier cost" },
  { value: "national", title: "National (03)", blurb: "Non-geographic, charged like a landline for callers.", monthly: "from £3.50/mo carrier cost" },
  { value: "tollfree", title: "Freephone (0800)", blurb: "Free for callers; you pay per inbound minute.", monthly: "from £2.70/mo carrier cost" },
  { value: "mobile", title: "Mobile (07)", blurb: "Looks like a mobile, rings wherever you route it.", monthly: "from £2.50/mo carrier cost" },
];

const FRIENDLY_LABEL: Record<string, string> = {
  business_name: "Business name",
  business_registration_number: "Companies House number",
  business_registration_authority: "Registration authority",
  business_identity: "Who uses the number",
  business_type: "Business type",
  business_industry: "Industry",
  website_url: "Website",
  first_name: "First name",
  last_name: "Last name",
  authorized_representative_first_name: "Authorised representative: first name",
  authorized_representative_last_name: "Authorised representative: last name",
  authorized_representative_email: "Authorised representative: email",
  authorized_representative_phone_number: "Authorised representative: phone",
  authorized_representative_job_position: "Authorised representative: job title",
  is_subassigned: "Is the number for someone else?",
  phone_number: "Contact phone number",
  email: "Contact email",
  comments: "Notes for the reviewer (optional)",
};

const DEFAULTS: Record<string, string> = {
  business_registration_authority: "UK:CRN",
  business_identity: "DIRECT_CUSTOMER",
  is_subassigned: "NO",
};

export type ResumeState = {
  numberId: string;
  chosen: AvailableNumber;
  endUserType: EndUserType;
  active: boolean;
  spec: RegulationSpec | null;
  /** Card step was cancelled at Stripe. */
  cancelled?: boolean;
  error?: string;
};

export function BuyFlow(props: {
  clientName: string;
  contactEmail: string;
  approvedTypes: string[];
  pendingTypes: string[];
  prefill: Record<string, string>;
  /** From the storefront: preselect this type and search for this number first. */
  initialType?: NumberType;
  initialContains?: string;
  /** Present when the browser has just returned from Stripe Checkout (Phase 3). */
  resume?: ResumeState;
}) {
  const r0 = props.resume;
  const [step, setStep] = useState<Step>(r0 ? (r0.cancelled || r0.error ? "card" : r0.active ? "active" : "kyc") : "type");
  const [type, setType] = useState<NumberType>(r0?.chosen.type ?? props.initialType ?? "local");
  const [endUserType, setEndUserType] = useState<EndUserType>(r0?.endUserType ?? "business");
  const [results, setResults] = useState<AvailableNumber[]>([]);
  const [chosen, setChosen] = useState<AvailableNumber | null>(r0?.chosen ?? null);
  const [numberId, setNumberId] = useState<string | null>(r0?.numberId ?? null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [spec, setSpec] = useState<RegulationSpec | null>(r0?.spec ?? null);
  const [failures, setFailures] = useState<EvaluationFailure[]>([]);
  const [bundleId, setBundleId] = useState<string | null>(null);
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

  const reserve = (n: AvailableNumber) => {
    setError(null);
    const fd = new FormData();
    fd.set("type", type);
    fd.set("e164", n.e164);
    fd.set("locality", n.locality ?? "");
    fd.set("endUserType", endUserType);
    start(async () => {
      const r = await reserveNumberAction(fd);
      if (!r.ok) return setError(r.error);
      setChosen(n);
      setNumberId(r.data.numberId);
      if (r.data.checkoutUrl) {
        setCheckoutUrl(r.data.checkoutUrl);
        return setStep("card");
      }
      if (r.data.active) return setStep("active");
      setSpec(r.data.spec);
      setStep("kyc");
    });
  };

  const retryCheckout = () => {
    if (!chosen) return;
    setError(null);
    const fd = new FormData();
    fd.set("type", type);
    fd.set("e164", chosen.e164);
    fd.set("locality", chosen.locality ?? "");
    fd.set("endUserType", endUserType);
    start(async () => {
      const r = await reserveNumberAction(fd);
      if (!r.ok) return setError(r.error);
      setNumberId(r.data.numberId);
      if (r.data.checkoutUrl) window.location.assign(r.data.checkoutUrl);
      else if (r.data.active) setStep("active");
      else {
        setSpec(r.data.spec);
        setStep("kyc");
      }
    });
  };

  const switchEndUser = (t: EndUserType) => {
    setEndUserType(t);
    start(async () => {
      const r = await regulationSpecAction(type, t);
      if (r.ok) setSpec(r.data);
      else setError(r.error);
    });
  };

  const submitKyc = (fd: FormData) => {
    setError(null);
    setFailures([]);
    fd.set("type", type);
    fd.set("endUserType", endUserType);
    start(async () => {
      const r = await submitKycAction(fd);
      if (!r.ok) return setError(r.error);
      setBundleId(r.data.bundleId);
      if (!r.data.compliant) return setFailures(r.data.failures);
      setStep("verifying");
    });
  };

  const forceSubmit = () => {
    if (!bundleId) return;
    start(async () => {
      const r = await submitBundleAction(bundleId, true);
      if (!r.ok) return setError(r.error);
      setStep("verifying");
    });
  };

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
              Reserving holds the number in your account. Because this is your first {typeLabel(type).toLowerCase()} number, Ofcom rules mean we need to register who owns it before it can go live.
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

      {step === "kyc" && spec && chosen && (
        <div className="card space-y-5">
          <div>
            <h2 className="font-semibold">Register {formatUk(chosen.e164)} with Ofcom</h2>
            <p className="mt-1 text-sm text-slate-600">
              UK numbers must be linked to a verified owner. This is a one-off per number type; Twilio reviews it, usually within 24 hours, and the number goes live automatically on approval.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-1 text-sm">
            <button type="button" onClick={() => switchEndUser("business")} className={`rounded px-3 py-1.5 ${endUserType === "business" ? "bg-white shadow" : "text-slate-500"}`}>
              Limited company / registered business
            </button>
            <button type="button" onClick={() => switchEndUser("individual")} className={`rounded px-3 py-1.5 ${endUserType === "individual" ? "bg-white shadow" : "text-slate-500"}`}>
              Sole trader / individual
            </button>
          </div>

          {failures.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <div className="font-medium">Twilio flagged these before submission:</div>
              <ul className="mt-1 list-disc pl-5">
                {failures.map((f, i) => (
                  <li key={i}>
                    <strong>{FRIENDLY_LABEL[f.field] ?? f.label}</strong>: {f.reason}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-3">
                <span>Fix the fields below and submit again, or</span>
                <button type="button" onClick={forceSubmit} className="underline">
                  submit anyway
                </button>
              </div>
            </div>
          )}

          <form action={submitKyc} className="space-y-5">
            <fieldset className="grid gap-4 md:grid-cols-2">
              <legend className="mb-2 text-sm font-semibold text-slate-700">Owner details</legend>
              {spec.endUserFields.map((f) => (
                <Field key={f.name} field={f} value={props.prefill[f.name] ?? DEFAULTS[f.name] ?? (f.name === "email" || f.name === "authorized_representative_email" ? props.contactEmail : "")} />
              ))}
            </fieldset>

            <fieldset className="grid gap-4 md:grid-cols-2">
              <legend className="mb-2 text-sm font-semibold text-slate-700">
                {spec.numberType === "local" || spec.numberType === "national" ? "UK address (no PO boxes)" : "Address (no PO boxes)"}
              </legend>
              <Text name="address_customer_name" label="Name on the address" value={props.prefill.address_customer_name ?? props.clientName} />
              <Text name="address_street" label="Street address" value={props.prefill.address_street ?? ""} />
              <Text name="address_city" label="Town / city" value={props.prefill.address_city ?? ""} />
              <Text name="address_region" label="County / region" value={props.prefill.address_region ?? ""} />
              <Text name="address_postal_code" label="Postcode" value={props.prefill.address_postal_code ?? ""} />
              <Text name="contact_email" label="Email for Twilio's review updates" value={props.prefill.contact_email ?? props.contactEmail} type="email" />
            </fieldset>

            {!spec.documentsFreeOfUploads && (
              <fieldset className="grid gap-4 md:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold text-slate-700">Proof of identity</legend>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Document type</span>
                  <select name="identity_document_type" className="input" defaultValue="passport">
                    {Array.from(new Set(spec.documents.flatMap((d) => d.acceptedDocuments.filter((a) => !a.isAddressBacked).map((a) => a.type)))).map((t) => (
                      <option key={t} value={t}>
                        {t.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Upload (PDF or image, max 5MB)</span>
                  <input name="identity_document" type="file" accept=".pdf,.png,.jpg,.jpeg" className="input" required />
                </label>
              </fieldset>
            )}

            <div className="flex items-center justify-between">
              <button type="button" onClick={() => setStep("results")} className="text-sm text-slate-500 hover:text-slate-900">
                Back
              </button>
              <button type="submit" disabled={pending} className="btn-primary">
                {pending ? "Submitting…" : "Submit registration"}
              </button>
            </div>
          </form>
        </div>
      )}

      {step === "verifying" && chosen && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Registration submitted</h2>
          <p className="text-sm text-slate-600">
            <strong className="tabular-nums text-slate-900">{formatUk(chosen.e164)}</strong> is reserved for you. Twilio is now verifying the registration with Ofcom&apos;s requirements. This usually
            completes within 24 hours, sometimes a few days.
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
    [["kyc"], "3. Register the owner"],
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

function Field({ field, value }: { field: RegulationSpec["endUserFields"][number]; value: string }) {
  const label = FRIENDLY_LABEL[field.name] ?? field.label;
  const required = field.name !== "comments";
  if (field.acceptedValues.length > 0) {
    return (
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{label}</span>
        <select name={field.name} defaultValue={value} className="input" required={required}>
          {field.acceptedValues.map((v) => (
            <option key={v} value={v}>
              {v.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {field.description && <span className="block text-xs text-slate-500">{field.description}</span>}
      </label>
    );
  }
  const type = /email/.test(field.name) ? "email" : /phone/.test(field.name) ? "tel" : /website|url/.test(field.name) ? "url" : "text";
  return <Text name={field.name} label={label} value={value} type={type} hint={field.description} required={required} />;
}

function Text({ name, label, value, type = "text", hint, required = true }: { name: string; label: string; value: string; type?: string; hint?: string; required?: boolean }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input name={name} type={type} defaultValue={value} className="input" required={required} />
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
