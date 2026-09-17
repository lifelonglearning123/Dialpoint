"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { registerTypeAction } from "../business/actions";

/** Submit the Ofcom registration for one number type from the stored business details. */
export function RegisterButton({ type, label }: { type: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string; items?: string[] } | null>(null);

  const submit = () => {
    setMessage(null);
    const fd = new FormData();
    fd.set("type", type);
    start(async () => {
      const r = await registerTypeAction(fd);
      if (!r.ok) return setMessage({ ok: false, text: r.error });
      const { status, failures } = r.data;
      if (status === "pending-review" || status === "in-review" || status === "twilio-approved") {
        setMessage({ ok: true, text: "Submitted to Ofcom. The number goes live automatically on approval." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: "Your business details are missing something this registration needs. Update them under Business, then try again.", items: failures.map((f) => `${f.label}: ${f.reason}`) });
      }
    });
  };

  return (
    <div className="space-y-2">
      <button type="button" onClick={submit} disabled={pending} className="btn-primary">
        {pending ? "Submitting…" : `Register ${label} with Ofcom`}
      </button>
      {message && (
        <div className={`rounded-md px-3 py-2 text-sm ${message.ok ? "bg-emerald-50 text-emerald-700" : "border border-red-200 bg-red-50 text-red-700"}`}>
          <div>{message.text}</div>
          {message.items && message.items.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {message.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
