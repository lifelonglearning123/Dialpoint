"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { emailCredsForAgency, ghlConfigured, renderSignInCodeEmail, sendGhlEmail } from "@/lib/email/ghl";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveAgency } from "@/lib/tenancy/resolve";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Step 1: email a one-time numeric code. Identical mechanism to Signal
 * (admin.generateLink → email_otp, sent through the agency's GHL) so the same
 * Supabase user signs in to both products with the same kind of code.
 */
export async function requestSignInCode(formData: FormData): Promise<ActionResult> {
  const parsed = z.object({ email: z.string().email() }).safeParse({ email: formData.get("email") });
  if (!parsed.success) return { ok: false, error: "Enter a valid email." };
  const email = parsed.data.email.trim().toLowerCase();

  const admin = createServiceRoleClient();
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) return { ok: false, error: listErr.message };
  // Always "succeed" so the form cannot be used to probe which emails exist.
  if (!list.users.some((u) => u.email?.toLowerCase() === email)) return { ok: true };

  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) return { ok: false, error: error.message };
  const code = data.properties?.email_otp;
  if (!code) return { ok: false, error: "Could not generate a sign-in code." };

  const agency = await resolveAgency();
  const creds = agency ? await emailCredsForAgency(agency.id) : null;
  if (!creds || !ghlConfigured(creds)) {
    console.log(`[sign-in-code] no CRM email configured for this agency. Code for ${email}: ${code}`);
    return { ok: true };
  }
  const { subject, html } = renderSignInCodeEmail({ code, brandName: agency!.name });
  try {
    await sendGhlEmail(creds, { to: email, subject, html });
  } catch (e) {
    console.error("[sign-in-code] send failed", e);
    return { ok: false, error: "Couldn't send the sign-in email. Try again in a moment." };
  }
  return { ok: true };
}

export type VerifyResult = { ok: false; error: string };

/** Step 2: verify the code; on success the session cookie is written and we redirect. */
export async function verifySignInCode(formData: FormData): Promise<VerifyResult | void> {
  const parsed = z
    .object({
      email: z.string().email(),
      code: z.string().trim().regex(/^\d{4,10}$/, "Enter the numeric code from your email."),
      next: z.string().optional(),
    })
    .safeParse({
      email: String(formData.get("email") ?? "").trim().toLowerCase(),
      code: String(formData.get("code") ?? ""),
      next: formData.get("next") ?? undefined,
    });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email: parsed.data.email, token: parsed.data.code, type: "magiclink" });
  if (error) return { ok: false, error: "That code is invalid or has expired. Request a new one." };

  const next = parsed.data.next && parsed.data.next.startsWith("/") ? parsed.data.next : "/app";
  redirect(next);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
