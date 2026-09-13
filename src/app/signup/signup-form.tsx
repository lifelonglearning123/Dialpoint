"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { requestSignInCode, verifySignInCode } from "@/app/login/actions";
import { startSignup } from "./actions";

export function SignupForm({ next, accent }: { next: string; accent: string }) {
  const [step, setStep] = useState<"details" | "code">("details");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState(false);
  const [pending, start] = useTransition();

  const submitDetails = (fd: FormData) => {
    setError(null);
    setSignIn(false);
    start(async () => {
      const r = await startSignup(fd);
      if (!r.ok) {
        setError(r.error);
        setSignIn(!!r.signIn);
        return;
      }
      setEmail(r.email);
      setStep("code");
    });
  };

  const submitCode = (fd: FormData) => {
    setError(null);
    fd.set("next", next);
    start(async () => {
      const r = await verifySignInCode(fd);
      if (r && !r.ok) setError(r.error);
    });
  };

  const resend = () => {
    const fd = new FormData();
    fd.set("email", email);
    start(async () => {
      const r = await requestSignInCode(fd);
      setError(r.ok ? null : r.error);
    });
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}{" "}
          {signIn && (
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="font-medium underline">
              Sign in
            </Link>
          )}
        </div>
      )}

      {step === "details" ? (
        <form action={submitDetails} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Business name</span>
            <input name="business" required minLength={2} maxLength={120} autoComplete="organization" className="input" placeholder="Acme Plumbing Ltd" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Your name</span>
            <input name="name" required minLength={2} maxLength={120} autoComplete="name" className="input" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Email</span>
            <input name="email" type="email" required autoComplete="email" className="input" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Mobile</span>
            <input name="mobile" type="tel" required autoComplete="tel" className="input" placeholder="07700 900123" />
            <span className="block text-xs text-slate-500">The phone your new number will ring by default. You can change this later.</span>
          </label>
          {/* Honeypot: hidden from people, filled by bots. */}
          <div className="hidden" aria-hidden>
            <label>
              Website <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <button type="submit" disabled={pending} className="btn-primary w-full py-2.5" style={{ background: accent }}>
            {pending ? "Creating your account…" : "Continue"}
          </button>
          <p className="text-xs text-slate-500">
            We&apos;ll email you a one-time code to sign in. No password to remember. Already have an account?{" "}
            <Link href="/login" className="underline">
              Sign in
            </Link>
            .
          </p>
        </form>
      ) : (
        <form action={submitCode} className="space-y-4">
          <input type="hidden" name="email" value={email} />
          <p className="text-sm text-slate-600">
            We emailed a code to <strong className="text-slate-900">{email}</strong>. Enter it below to finish.
          </p>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Sign-in code</span>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4,10}" maxLength={10} autoFocus required className="input text-center tracking-[0.3em]" />
          </label>
          <button type="submit" disabled={pending} className="btn-primary w-full py-2.5" style={{ background: accent }}>
            {pending ? "Signing in…" : "Finish and choose my number"}
          </button>
          <div className="flex justify-end text-xs text-slate-500">
            <button type="button" onClick={resend} disabled={pending} className="hover:text-slate-900">
              Resend code
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
