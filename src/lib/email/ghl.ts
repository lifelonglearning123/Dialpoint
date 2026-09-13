import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies } from "@/db/shared";
import { decryptCredentialOrNull } from "@/lib/crypto/credentials";

/**
 * Transactional email through the agency's own GoHighLevel location, exactly
 * as Signal does it (src/lib/email/ghl.ts there), so sign-in codes come from
 * the agency's address. Credentials are read from Signal's agencies row.
 */
const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

export type GhlEmailCreds = {
  ghlApiKey: string | null;
  ghlLocationId: string | null;
  ghlFromEmail: string | null;
};

export async function emailCredsForAgency(agencyId: string): Promise<GhlEmailCreds> {
  const [row] = await db
    .select({ enc: agencies.ghlApiKeyEnc, loc: agencies.ghlLocationId, from: agencies.ghlFromEmail })
    .from(agencies)
    .where(eq(agencies.id, agencyId))
    .limit(1);
  if (!row) return { ghlApiKey: null, ghlLocationId: null, ghlFromEmail: null };
  return { ghlApiKey: decryptCredentialOrNull(row.enc), ghlLocationId: row.loc, ghlFromEmail: row.from };
}

export function ghlConfigured(c: GhlEmailCreds) {
  return !!(c.ghlApiKey && c.ghlLocationId && c.ghlFromEmail);
}

function authHeaders(c: GhlEmailCreds) {
  if (!ghlConfigured(c)) throw new Error("CRM email is not configured for this agency.");
  return {
    Authorization: `Bearer ${c.ghlApiKey}`,
    Version: VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  } as const;
}

async function upsertContact(c: GhlEmailCreds, email: string): Promise<string> {
  const res = await fetch(`${BASE}/contacts/upsert`, {
    method: "POST",
    headers: authHeaders(c),
    body: JSON.stringify({ locationId: c.ghlLocationId, email }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`CRM upsertContact failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { contact?: { id?: string }; id?: string };
  const id = data.contact?.id ?? data.id;
  if (!id) throw new Error("CRM upsertContact returned no contact id");
  return id;
}

export async function sendGhlEmail(c: GhlEmailCreds, opts: { to: string; subject: string; html: string }) {
  const contactId = await upsertContact(c, opts.to);
  const res = await fetch(`${BASE}/conversations/messages`, {
    method: "POST",
    headers: authHeaders(c),
    body: JSON.stringify({ type: "Email", contactId, subject: opts.subject, html: opts.html, emailFrom: c.ghlFromEmail }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`CRM send email failed (${res.status}): ${await res.text()}`);
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function renderSignInCodeEmail(opts: { code: string; brandName: string }) {
  const subject = `Your ${opts.brandName} sign-in code`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #e2e8f0;"><div style="font-size:14px;color:#64748b;">${escape(opts.brandName)}</div></td></tr>
      <tr><td style="padding:28px;">
        <h1 style="margin:0 0 12px;font-size:20px;">Sign in to ${escape(opts.brandName)}</h1>
        <p style="margin:0 0 20px;color:#334155;line-height:1.5;">Enter this code on the sign-in screen. It expires in 1 hour and can be used once.</p>
        <div style="margin:0 0 24px;padding:16px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center;">
          <div style="font-size:32px;font-weight:700;letter-spacing:0.3em;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">${escape(opts.code)}</div>
        </div>
        <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">If you didn't try to sign in, ignore this email. Never share this code.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html };
}
