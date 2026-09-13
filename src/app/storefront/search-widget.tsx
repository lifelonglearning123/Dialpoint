"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { formatUk } from "@/lib/format";
import type { AvailableNumber, NumberType } from "@/lib/twilio/numbers";
import { publicSearchAction } from "./actions";

const TYPES: Array<{ value: NumberType; label: string; hint: string }> = [
  { value: "local", label: "Local", hint: "01 / 02, your town" },
  { value: "national", label: "National", hint: "03, charged like a landline" },
  { value: "tollfree", label: "Freephone", hint: "0800, free to call" },
  { value: "mobile", label: "Mobile", hint: "07" },
];

export function SearchWidget({ accent }: { accent: string }) {
  const [type, setType] = useState<NumberType>("local");
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const search = (fd: FormData) => {
    setError(null);
    fd.set("type", type);
    start(async () => {
      const r = await publicSearchAction(fd);
      if (!r.ok) {
        setResults(null);
        return setError(r.error);
      }
      setResults(r.data);
    });
  };

  return (
    <div className="rounded-2xl bg-white p-5 shadow-lg ring-1 ring-slate-200 sm:p-6">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Number type">
        {TYPES.map((t) => {
          const active = type === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setType(t.value);
                setResults(null);
              }}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition ${active ? "text-white ring-transparent" : "bg-white text-slate-700 ring-slate-300 hover:ring-slate-400"}`}
              style={active ? { background: accent } : undefined}
              title={t.hint}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <form action={search} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          name="contains"
          inputMode="numeric"
          placeholder={type === "local" ? "Area code, e.g. 020, 0161, 01865" : type === "national" ? "Digits you'd like, e.g. 0330 (optional)" : type === "tollfree" ? "Digits you'd like (optional)" : "Digits you'd like, e.g. 07700 (optional)"}
          className="input flex-1 py-3 text-base"
        />
        <button type="submit" disabled={pending} className="btn-primary py-3 text-base sm:min-w-40" style={{ background: accent }}>
          {pending ? "Searching…" : "Find numbers"}
        </button>
      </form>
      <p className="mt-2 text-xs text-slate-500">
        {type === "local" && "Local numbers need a UK business address for Ofcom registration."}
        {type === "national" && "03 numbers cost callers the same as a landline, from anywhere in the UK."}
        {type === "tollfree" && "Free for your callers; inbound minutes are billed to you."}
        {type === "mobile" && "A mobile number that rings wherever you route it."}
      </p>

      {error && <div className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {results && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {results.length === 0 && <li className="px-4 py-4 text-sm text-slate-600">Nothing matched. Try a broader area code.</li>}
          {results.map((n) => (
            <li key={n.e164} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="font-medium tabular-nums text-slate-900">{formatUk(n.e164)}</div>
                {n.locality && <div className="text-xs text-slate-500">{n.locality}</div>}
              </div>
              <Link
                href={`/signup?number=${encodeURIComponent(n.e164)}&type=${n.type}`}
                className="btn-secondary whitespace-nowrap"
              >
                Get started
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
