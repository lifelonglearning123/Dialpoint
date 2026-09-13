"use server";

import { headers } from "next/headers";
import { masterClient } from "@/lib/twilio/master";
import type { AvailableNumber, NumberType } from "@/lib/twilio/numbers";
import { resolveAgency } from "@/lib/tenancy/resolve";

const TYPES: NumberType[] = ["local", "national", "tollfree", "mobile"];

// Signed-out visitors can hit this, so keep a small per-IP budget: Twilio
// searches are free but rate-limited per account, and this is the master.
const WINDOW_MS = 60_000;
const BUDGET = 12;
const hits = new Map<string, number[]>();

async function allowed(): Promise<boolean> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "local").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= BUDGET) return false;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}

/** Normalise "020", "0207 946", "01865" → Twilio contains pattern "4420*". */
function toContains(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;
  const national = digits.startsWith("0") ? digits.slice(1) : digits.startsWith("44") ? digits.slice(2) : digits;
  return national ? `44${national}*` : undefined;
}

export type PublicSearchResult = { ok: true; data: AvailableNumber[] } | { ok: false; error: string };

/**
 * Live availability for the landing page. Uses the master account (no
 * customer exists yet); nothing is reserved. Same type → Twilio inventory
 * mapping as src/lib/twilio/numbers.ts (03 lives in Local with 443*).
 */
export async function publicSearchAction(formData: FormData): Promise<PublicSearchResult> {
  try {
    if (!(await resolveAgency())) return { ok: false, error: "This domain is not set up." };
    if (!(await allowed())) return { ok: false, error: "Too many searches. Try again in a minute." };
    const type = String(formData.get("type") ?? "local") as NumberType;
    if (!TYPES.includes(type)) return { ok: false, error: "Choose a number type." };
    const contains = toContains(String(formData.get("contains") ?? ""));

    const available = masterClient().availablePhoneNumbers("GB");
    const params = { voiceEnabled: true, limit: 8 } as const;
    let list: Array<{ phoneNumber: string; locality?: string | null; friendlyName?: string }>;
    if (type === "national") list = await available.local.list({ ...params, contains: contains && contains.startsWith("443") ? contains : "443*" });
    else if (type === "tollfree") list = await available.tollFree.list({ ...params, ...(contains ? { contains } : {}) });
    else if (type === "mobile") list = await available.mobile.list({ ...params, ...(contains ? { contains } : {}) });
    else list = await available.local.list({ ...params, ...(contains ? { contains } : {}) });

    return {
      ok: true,
      data: list.map((n) => ({ e164: n.phoneNumber, locality: n.locality ?? null, type, friendly: n.friendlyName ?? n.phoneNumber })),
    };
  } catch (e) {
    console.error("[storefront] search failed", e);
    return { ok: false, error: "Number search is unavailable right now. Try again shortly." };
  }
}
