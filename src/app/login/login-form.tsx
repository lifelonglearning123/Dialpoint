"use client";

import { useState, useTransition } from "react";
import { requestSignInCode, verifySignInCode } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const sendCode = (fd: FormData) => {
    setError(null);
    start(async () => {
      const res = await requestSignInCode(fd);
      if (res.ok) {
        setEmail(String(fd.get("email") ?? "").trim());
        setStep("code");
      } else setError(res.error);
    });
  };

  const submitCode = (fd: FormData) => {
    setError(null);
    if (next) fd.set("next", next);
    start(async () => {
      const res = await verifySignInCode(fd);
      if (res && !res.ok) setError(res.error);
    });
  };

  const resend = () => {
    const fd = new FormData();
    fd.set("email", email);
    start(async () => {
      const res = await requestSignInCode(fd);
      setError(res.ok ? null : res.error);
    });
  };

  return (
    <div className="space-y-5">
      {error && <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {step === "email" ? (
        <form action={sendCode} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Email</span>
            <input name="email" type="email" autoComplete="email" required className="input" />
          </label>
          <button type="submit" disabled={pending} className="btn-primary w-full">
            {pending ? "Sending…" : "Email me a sign-in code"}
          </button>
        </form>
      ) : (
        <form action={submitCode} className="space-y-4">
          <input type="hidden" name="email" value={email} />
          <p className="text-sm text-slate-600">
            We emailed a code to <strong className="text-slate-900">{email}</strong>. Enter it below.
          </p>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Sign-in code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4,10}"
              maxLength={10}
              autoFocus
              required
              className="input text-center tracking-[0.3em]"
            />
          </label>
          <button type="submit" disabled={pending} className="btn-primary w-full">
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <div className="flex justify-between text-xs text-slate-500">
            <button type="button" onClick={() => setStep("email")} disabled={pending} className="hover:text-slate-900">
              Use a different email
            </button>
            <button type="button" onClick={resend} disabled={pending} className="hover:text-slate-900">
              Resend code
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
