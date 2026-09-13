import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers, regulatoryBundles, type numberType } from "@/db/schema";
import { clients } from "@/db/shared";
import { syncActiveNumberQuantity } from "@/lib/billing/subscription";
import { ensureSubaccount, publicBaseUrl, subaccountClient } from "./master";

export type NumberType = (typeof numberType.enumValues)[number];

export type AvailableNumber = {
  e164: string;
  locality: string | null;
  type: NumberType;
  friendly: string;
};

/**
 * Search Twilio GB inventory. Mapping verified 2026-09-13 on the master
 * account: 03 national numbers are listed under Twilio's *Local* type (search
 * with contains "443*"; the National endpoint 404s for GB), 0800/0808 under
 * TollFree, 07 under Mobile.
 */
export async function searchNumbers(opts: {
  clientId: string;
  type: NumberType;
  /** Digit pattern, e.g. "4420*" for London or "441865*" for Oxford. */
  contains?: string;
  /** Twilio locality name, e.g. "London". Only meaningful for local. */
  locality?: string;
  limit?: number;
}): Promise<AvailableNumber[]> {
  // Searching does not need the customer's subaccount to exist; the master
  // sees the same inventory. Use the subaccount when we have one anyway so
  // Twilio's per-account rate limits are the customer's own.
  const client = await subaccountClient(opts.clientId).catch(() => null);
  const { masterClient } = await import("./master");
  const tw = client ?? masterClient();
  const limit = opts.limit ?? 10;
  const available = tw.availablePhoneNumbers("GB");

  const params: Record<string, unknown> = { voiceEnabled: true, limit };
  let list: Array<{ phoneNumber: string; locality?: string | null; friendlyName?: string }>;

  if (opts.type === "national") {
    list = await available.local.list({ ...params, contains: opts.contains && opts.contains.startsWith("443") ? opts.contains : "443*" });
  } else if (opts.type === "tollfree") {
    list = await available.tollFree.list({ ...params, ...(opts.contains ? { contains: opts.contains } : {}) });
  } else if (opts.type === "mobile") {
    list = await available.mobile.list({ ...params, ...(opts.contains ? { contains: opts.contains } : {}) });
  } else {
    list = await available.local.list({
      ...params,
      ...(opts.contains ? { contains: opts.contains } : {}),
      ...(opts.locality ? { inLocality: opts.locality } : {}),
    });
  }

  return list.map((n) => ({
    e164: n.phoneNumber,
    locality: n.locality ?? null,
    type: opts.type,
    friendly: n.friendlyName ?? n.phoneNumber,
  }));
}

/** Twilio's regulation NumberType for each of our types. */
export function regulationTypeFor(type: NumberType): "local" | "mobile" | "toll-free" | "national" {
  return type === "tollfree" ? "toll-free" : type;
}

/**
 * Hold the number in our table before KYC. Nothing is bought yet: Twilio does
 * not reserve inventory, so the buy step re-checks availability.
 */
export async function reserveNumber(opts: { clientId: string; agencyId: string; e164: string; type: NumberType; locality?: string | null }) {
  const [row] = await db
    .insert(numbers)
    .values({
      clientId: opts.clientId,
      agencyId: opts.agencyId,
      e164: opts.e164,
      type: opts.type,
      locality: opts.locality ?? null,
      status: "reserved",
    })
    .returning();
  return row;
}

/** The approved bundle (with an address) this client holds for a number type, if any. */
export async function approvedBundleFor(clientId: string, type: NumberType) {
  const rows = await db.query.regulatoryBundles.findMany({
    where: and(eq(regulatoryBundles.clientId, clientId), eq(regulatoryBundles.status, "twilio-approved")),
  });
  // 03 numbers sit in Twilio's Local inventory; a Local bundle is what Twilio
  // checks at purchase. Prefer an exact-type bundle, fall back to local for 03.
  return rows.find((b) => b.numberType === type) ?? (type === "national" ? rows.find((b) => b.numberType === "local") : undefined) ?? null;
}

/**
 * Buy a reserved number in the client's subaccount. Requires an approved
 * bundle of the right type with a validated address (Twilio needs BOTH for UK
 * numbers, error 21631 otherwise). Points the number at this app's voice
 * webhook so routing starts on the first call.
 */
export async function purchaseNumber(numberId: string) {
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row) throw new Error("Number not found.");
  if (row.status === "active") return row;
  if (row.status === "released") throw new Error("This number was released.");

  const bundle = await approvedBundleFor(row.clientId, row.type);
  if (!bundle) throw new Error("No approved Ofcom registration for this number type yet.");
  if (!bundle.addressSid) throw new Error("The approved registration has no validated address.");

  const client = await db.query.clients.findFirst({ where: eq(clients.id, row.clientId), columns: { name: true } });
  const { client: tw } = await ensureSubaccount(row.clientId, client?.name ?? "client");
  const base = publicBaseUrl();

  const bought = await tw.incomingPhoneNumbers.create({
    phoneNumber: row.e164,
    friendlyName: row.label ?? `${client?.name ?? "client"} ${row.e164}`,
    bundleSid: bundle.bundleSid,
    addressSid: bundle.addressSid,
    voiceUrl: `${base}/api/voice/inbound`,
    voiceMethod: "POST",
    statusCallback: `${base}/api/voice/status?leg=parent`,
    statusCallbackMethod: "POST",
  });

  const [updated] = await db
    .update(numbers)
    .set({ status: "active", twilioSid: bought.sid, bundleId: bundle.id, addressSid: bundle.addressSid, activatedAt: new Date() })
    .where(eq(numbers.id, numberId))
    .returning();
  // Billing (Phase 3): one more licensed unit on the subscription, prorated.
  await syncActiveNumberQuantity(row.clientId).catch((e) => console.error("[billing] quantity sync", e));
  return updated;
}

/** Re-point a live number's webhooks (after PUBLIC_BASE_URL changes). */
export async function repointNumber(numberId: string) {
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row?.twilioSid) return;
  const tw = await subaccountClient(row.clientId);
  const base = publicBaseUrl();
  await tw.incomingPhoneNumbers(row.twilioSid).update({
    voiceUrl: `${base}/api/voice/inbound`,
    voiceMethod: "POST",
    statusCallback: `${base}/api/voice/status?leg=parent`,
    statusCallbackMethod: "POST",
  });
}

/** Release: gives the number back to Twilio (stops the monthly charge). Irreversible. */
export async function releaseNumber(numberId: string) {
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row) throw new Error("Number not found.");
  if (row.twilioSid) {
    const tw = await subaccountClient(row.clientId);
    await tw.incomingPhoneNumbers(row.twilioSid).remove().catch((e: Error) => {
      // Already gone in Twilio is fine; anything else is real.
      if (!/20404|not found/i.test(e.message)) throw e;
    });
  }
  await db.update(numbers).set({ status: "released", releasedAt: new Date() }).where(eq(numbers.id, numberId));
  // Billing (Phase 3): one fewer licensed unit (never below 1 while subscribed).
  await syncActiveNumberQuantity(row.clientId).catch((e) => console.error("[billing] quantity sync", e));
}

/** Activate every reserved number of a type once its bundle is approved. */
export async function activateReservedNumbers(clientId: string, type: NumberType) {
  const types: NumberType[] = type === "local" ? ["local", "national"] : [type];
  const reserved = await db.query.numbers.findMany({
    where: and(eq(numbers.clientId, clientId), eq(numbers.status, "reserved"), inArray(numbers.type, types)),
  });
  const results: Array<{ numberId: string; ok: boolean; error?: string }> = [];
  for (const r of reserved) {
    try {
      await purchaseNumber(r.id);
      results.push({ numberId: r.id, ok: true });
    } catch (e) {
      results.push({ numberId: r.id, ok: false, error: String((e as Error).message) });
    }
  }
  return results;
}
