"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { FIELD_DEFAULTS, FIELD_LABELS, TYPE_TITLES } from "@/lib/twilio/business-labels";
import type { RegisterResult, TypeRegistration } from "@/lib/twilio/business";
import type { AddressInput, EndUserType, EvaluationFailure, RegulationSpec } from "@/lib/twilio/regulatory";
import { businessSpecAction, registerTypeAction, saveBusinessAction } from "./actions";

export function BusinessForm(props: {
  spec: RegulationSpec;
  endUserType: EndUserType;
  attributes: Record<string, string>;
  address: AddressInput | null;
  contactEmail: string;
  clientName: string;
  hasProfile: boolean;
}) {
  const [spec, setSpec] = useState(props.spec);
  const [endUserType, setEndUserType] = useState<EndUserType>(props.endUserType);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const switchType = (t: EndUserType) => {
    setEndUserType(t);
    setError(null);
    start(async () => {
      const r = await businessSpecAction(t);
      if (r.ok) setSpec(r.data);
      else setError(r.error);
    });
  };

  const save = (fd: FormData) => {
    setError(null);
    setSaved(false);
    fd.set("endUserType", endUserType);
    start(async () => {
      const r = await saveBusinessAction(fd);
      if (!r.ok) return setError(r.error);
      setSaved(true);
    });
  };

  return (
    <form action={save} className="card space-y-5">
      {error && <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {saved && <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-700">Saved. Register the number types you need below.</div>}

      <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-1 text-sm">
        <button type="button" onClick={() => switchType("business")} className={`rounded px-3 py-1.5 ${endUserType === "business" ? "bg-white shadow" : "text-slate-500"}`}>
          Limited company / registered business
        </button>
        <button type="button" onClick={() => switchType("individual")} className={`rounded px-3 py-1.5 ${endUserType === "individual" ? "bg-white shadow" : "text-slate-500"}`}>
          Sole trader / individual
        </button>
      </div>

      <fieldset className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-700">{endUserType === "business" ? "Company details" : "Your details"}</legend>
        {spec.endUserFields.map((f) => (
          <Field
            key={f.name}
            field={f}
            value={props.attributes[f.name] ?? FIELD_DEFAULTS[f.name] ?? (f.name === "email" || f.name === "authorized_representative_email" ? props.contactEmail : "")}
          />
        ))}
      </fieldset>

      <fieldset className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-700">Registered address (UK, no PO boxes)</legend>
        <Text name="address_customer_name" label="Name on the address" value={props.address?.customerName ?? props.clientName} />
        <Text name="address_street" label="Street address" value={props.address?.street ?? ""} />
        <Text name="address_city" label="Town / city" value={props.address?.city ?? ""} />
        <Text name="address_region" label="County / region" value={props.address?.region ?? ""} />
        <Text name="address_postal_code" label="Postcode" value={props.address?.postalCode ?? ""} />
        <Text name="contact_email" label="Email for Ofcom review updates" value={props.contactEmail} type="email" />
      </fieldset>

      {endUserType === "individual" && (
        <p className="text-xs text-slate-500">Sole traders also upload a passport or government ID when registering a number type below; the file is sent to Twilio and not stored here.</p>
      )}

      <div className="flex items-center justify-end gap-3">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? "Saving…" : props.hasProfile ? "Save changes" : "Save business details"}
        </button>
      </div>
    </form>
  );
}

const STATE_LABEL: Record<TypeRegistration["state"], { label: string; cls: string }> = {
  not_registered: { label: "not registered", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
  draft: { label: "needs attention", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  "pending-review": { label: "pending review", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  "in-review": { label: "in review", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  "twilio-approved": { label: "approved", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  "provisionally-approved": { label: "provisionally approved", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  "twilio-rejected": { label: "rejected", cls: "bg-red-50 text-red-700 ring-red-200" },
};

export function RegistrationCards(props: {
  registrations: TypeRegistration[];
  canManage: boolean;
  hasProfile: boolean;
  endUserType: EndUserType;
  returnTo: string | null;
}) {
  const [results, setResults] = useState<Record<string, RegisterResult | { error: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const register = (type: string, fd: FormData, force = false) => {
    fd.set("type", type);
    if (force) fd.set("force", "1");
    setBusy(type);
    start(async () => {
      const r = await registerTypeAction(fd);
      setResults((m) => ({ ...m, [type]: r.ok ? r.data : { error: r.error } }));
      setBusy(null);
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {props.registrations.map((reg) => {
        const res = results[reg.type];
        const state = res && "status" in res && res.status !== "not_registered" ? res.status : reg.state;
        const s = STATE_LABEL[state as TypeRegistration["state"]] ?? STATE_LABEL.not_registered;
        const failures: EvaluationFailure[] = res && "failures" in res ? res.failures : [];
        const canRegister = props.canManage && props.hasProfile && !["pending-review", "in-review", "twilio-approved", "provisionally-approved"].includes(state);
        return (
          <div key={reg.type} className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium">{TYPE_TITLES[reg.type]}</h3>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${s.cls}`}>{s.label}</span>
            </div>
            {state === "twilio-rejected" && reg.failureReason && <p className="mt-2 text-xs text-red-700">{reg.failureReason}</p>}
            {(state === "pending-review" || state === "in-review") && <p className="mt-2 text-xs text-slate-500">Submitted{reg.submittedAt ? ` ${new Date(reg.submittedAt).toLocaleDateString("en-GB")}` : ""}. We check with Twilio automatically.</p>}
            {(state === "twilio-approved" || state === "provisionally-approved") && <p className="mt-2 text-xs text-slate-500">Numbers of this type are bought instantly.</p>}
            {res && "error" in res && <p className="mt-2 text-xs text-red-700">{res.error}</p>}
            {failures.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-800">
                {failures.map((f, i) => (
                  <li key={i}>
                    <strong>{FIELD_LABELS[f.field] ?? f.label}</strong>: {f.reason}
                  </li>
                ))}
              </ul>
            )}
            {canRegister && (
              <form action={(fd) => register(reg.type, fd)} className="mt-3 space-y-2">
                {props.endUserType === "individual" && (
                  <>
                    <select name="identity_document_type" className="input" defaultValue="passport">
                      <option value="passport">passport</option>
                      <option value="government_issued_document">government issued document</option>
                      <option value="drivers_license">driving licence</option>
                    </select>
                    <input name="identity_document" type="file" accept=".pdf,.png,.jpg,.jpeg" className="input" required />
                  </>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={busy === reg.type} className="btn-secondary">
                    {busy === reg.type ? "Registering…" : state === "not_registered" ? "Register" : "Re-submit"}
                  </button>
                  {failures.length > 0 && res && "bundleId" in res && res.bundleId && (
                    <button type="button" disabled={busy === reg.type} onClick={() => register(reg.type, new FormData(), true)} className="text-xs text-slate-500 underline">
                      submit anyway
                    </button>
                  )}
                </div>
              </form>
            )}
            {!props.hasProfile && props.canManage && <p className="mt-3 text-xs text-slate-500">Save your business details first.</p>}
            {props.returnTo && (state === "pending-review" || state === "in-review" || state === "twilio-approved") && (
              <Link href={props.returnTo} className="mt-3 inline-block text-xs font-medium underline">
                Continue with your number
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ field, value }: { field: RegulationSpec["endUserFields"][number]; value: string }) {
  const label = FIELD_LABELS[field.name] ?? field.label;
  const required = field.name !== "comments";
  const name = `attr:${field.name}`;
  if (field.acceptedValues.length > 0) {
    return (
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{label}</span>
        <select name={name} defaultValue={value} className="input" required={required}>
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
  return <Text name={name} label={label} value={value} type={type} hint={field.description} required={required} />;
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
