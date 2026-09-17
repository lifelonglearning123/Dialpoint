"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { agencies } from "@/db/shared";
import { publishPlan } from "@/lib/billing/plans";
import { CURRENCIES, floorFor, USAGE_MODES, wholesaleFloor } from "@/lib/billing/pricing";
import { stripeConfigured } from "@/lib/billing/stripe";
import { isAgency, requireSession } from "@/lib/auth";

/** `warning`: the plan saved but could not be published to Stripe (the message says why). */
export type PlanResult = { ok: true; warning?: string } | { ok: false; error: string; problems?: string[] };

async function agencySession() {
  const session = await requireSession();
  if (!isAgency(session.role)) throw new Error("Agency staff only.");
  return session;
}

/** Stripe is connected with charges enabled, so publishing can succeed. */
async function stripeReady(agencyId: string) {
  if (!stripeConfigured()) return false;
  const [a] = await db.select({ acct: agencies.stripeAccountId, charges: agencies.stripeChargesEnabled }).from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  return !!a?.acct && !!a.charges;
}

/**
 * Publish straight after a save or a default change, so an agency never has to
 * know Stripe is a separate step. Returns a warning instead of failing: the
 * plan is saved either way, and the first checkout publishes it too.
 */
async function autoPublish(planId: string, agencyId: string): Promise<string | undefined> {
  if (!(await stripeReady(agencyId))) return "Saved. It will go on Stripe automatically once Stripe is connected with charges enabled.";
  try {
    await publishPlan(planId);
    return undefined;
  } catch (e) {
    return `Saved, but publishing to Stripe failed: ${(e as Error).message}`;
  }
}

const num = (v: FormDataEntryValue | null) => Number(String(v ?? "0").replace(/[^0-9.]/g, "")) || 0;
/** "9.00" → 900 minor units. */
const major = (v: FormDataEntryValue | null) => Math.round(num(v) * 100);
/** "5" → 5 minor units. */
const minor = (v: FormDataEntryValue | null) => Math.round(num(v));
/** "3" (%) → 300 basis points. */
const percentToBps = (v: FormDataEntryValue | null) => Math.round(num(v) * 100);

const money = z.number().int().min(0);
const schema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  currency: z.enum(CURRENCIES),
  carrierMonthlyPence: z.object({ local: money, national: money, tollfree: money, mobile: money }),
  hostingMonthlyPence: money,
  includedMinutes: z.number().int().min(0).max(100000),
  perMinutePence: money,
  freephoneInboundPence: money,
  voicemailTranscribePence: money,
  surchargeBps: z.number().int().min(0).max(2000),
  usageMode: z.enum(USAGE_MODES),
});

/** Create or update a plan; refuses anything under the wholesale floor. */
export async function savePlan(formData: FormData): Promise<PlanResult> {
  try {
    const session = await agencySession();
    const id = String(formData.get("id") ?? "");
    const parsed = schema.safeParse({
      name: formData.get("name"),
      description: String(formData.get("description") ?? "").trim() || undefined,
      currency: String(formData.get("currency") ?? "GBP").toUpperCase(),
      carrierMonthlyPence: {
        local: major(formData.get("carrierLocal")),
        national: major(formData.get("carrierNational")),
        tollfree: major(formData.get("carrierTollfree")),
        mobile: major(formData.get("carrierMobile")),
      },
      hostingMonthlyPence: major(formData.get("hostingMonthly")),
      includedMinutes: minor(formData.get("includedMinutes")),
      perMinutePence: minor(formData.get("perMinute")),
      freephoneInboundPence: minor(formData.get("freephoneInbound")),
      voicemailTranscribePence: minor(formData.get("voicemailTranscribe")),
      surchargeBps: percentToBps(formData.get("surchargePercent")),
      usageMode: formData.get("usageMode") === "passthrough" ? "passthrough" : "flat",
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
    const data = { ...parsed.data, description: parsed.data.description ?? null };
    if (data.usageMode === "passthrough") {
      // Calls bill at Twilio's price, so the rate-card fields are unused; keep
      // them at the GBP floor so nothing downstream sees an under-cost rate.
      data.currency = "GBP";
      const floor = floorFor("GBP");
      data.includedMinutes = 0;
      data.perMinutePence = floor.perMinute;
      data.freephoneInboundPence = floor.freephoneInbound;
    }

    let planId = id;
    if (id) {
      const existing = await db.query.plans.findFirst({ where: and(eq(plans.id, id), eq(plans.agencyId, session.agencyId)) });
      if (!existing) throw new Error("Plan not found.");
      // Stripe prices and subscriptions are single-currency: once published the currency is fixed.
      if (existing.publishedAt) data.currency = existing.currency as (typeof CURRENCIES)[number];
      const floor = wholesaleFloor(data);
      if (!floor.ok) return { ok: false, error: "This plan is below the wholesale floor.", problems: floor.problems };
      await db.update(plans).set(data).where(eq(plans.id, existing.id));
    } else {
      const floor = wholesaleFloor(data);
      if (!floor.ok) return { ok: false, error: "This plan is below the wholesale floor.", problems: floor.problems };
      const others = await db.query.plans.findMany({ where: eq(plans.agencyId, session.agencyId), columns: { id: true } });
      const [created] = await db
        .insert(plans)
        .values({ ...data, agencyId: session.agencyId, isDefault: others.length === 0 })
        .returning({ id: plans.id });
      planId = created.id;
    }
    const warning = await autoPublish(planId, session.agencyId);
    revalidatePath("/app/agency/plans");
    revalidatePath("/");
    return { ok: true, warning };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function publishPlanAction(formData: FormData): Promise<PlanResult> {
  try {
    const session = await agencySession();
    const id = String(formData.get("id") ?? "");
    const plan = await db.query.plans.findFirst({ where: and(eq(plans.id, id), eq(plans.agencyId, session.agencyId)) });
    if (!plan) throw new Error("Plan not found.");
    await publishPlan(plan.id);
    revalidatePath("/app/agency/plans");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The "retry" badge on the Plans page: form actions must return nothing. */
export async function retryPublish(formData: FormData): Promise<void> {
  await publishPlanAction(formData);
}

export async function setDefaultPlan(formData: FormData) {
  const session = await agencySession();
  const id = String(formData.get("id") ?? "");
  await db.update(plans).set({ isDefault: false }).where(eq(plans.agencyId, session.agencyId));
  const [plan] = await db
    .update(plans)
    .set({ isDefault: true, active: true })
    .where(and(eq(plans.id, id), eq(plans.agencyId, session.agencyId)))
    .returning({ id: plans.id, publishedAt: plans.publishedAt });
  // The default is what new customers get, so make sure it is on Stripe.
  if (plan && !plan.publishedAt) await autoPublish(plan.id, session.agencyId);
  revalidatePath("/app/agency/plans");
  revalidatePath("/");
}

export async function togglePlanActive(formData: FormData) {
  const session = await agencySession();
  const id = String(formData.get("id") ?? "");
  const plan = await db.query.plans.findFirst({ where: and(eq(plans.id, id), eq(plans.agencyId, session.agencyId)) });
  if (!plan) return;
  await db.update(plans).set({ active: !plan.active, isDefault: plan.active ? false : plan.isDefault }).where(eq(plans.id, id));
  revalidatePath("/app/agency/plans");
  revalidatePath("/");
}
