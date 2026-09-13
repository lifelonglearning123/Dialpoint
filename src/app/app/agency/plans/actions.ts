"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { publishPlan, wholesaleFloor } from "@/lib/billing/plans";
import { isAgency, requireSession } from "@/lib/auth";

export type PlanResult = { ok: true } | { ok: false; error: string; problems?: string[] };

async function agencySession() {
  const session = await requireSession();
  if (!isAgency(session.role)) throw new Error("Agency staff only.");
  return session;
}

const pounds = (v: FormDataEntryValue | null) => Math.round(Number(String(v ?? "0").replace(/[^0-9.]/g, "")) * 100);
const pence = (v: FormDataEntryValue | null) => Math.round(Number(String(v ?? "0").replace(/[^0-9.]/g, "")));

const schema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  numberMonthlyPence: z.number().int().min(0),
  includedMinutes: z.number().int().min(0).max(100000),
  perMinutePence: z.number().int().min(0),
  freephoneInboundPence: z.number().int().min(0),
  voicemailTranscribePence: z.number().int().min(0),
});

/** Create or update a plan; refuses anything under the wholesale floor. */
export async function savePlan(formData: FormData): Promise<PlanResult> {
  try {
    const session = await agencySession();
    const id = String(formData.get("id") ?? "");
    const parsed = schema.safeParse({
      name: formData.get("name"),
      description: String(formData.get("description") ?? "").trim() || undefined,
      numberMonthlyPence: pounds(formData.get("numberMonthly")),
      includedMinutes: pence(formData.get("includedMinutes")),
      perMinutePence: pence(formData.get("perMinute")),
      freephoneInboundPence: pence(formData.get("freephoneInbound")),
      voicemailTranscribePence: pence(formData.get("voicemailTranscribe")),
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
    const floor = wholesaleFloor(parsed.data);
    if (!floor.ok) return { ok: false, error: "This plan is below the wholesale floor.", problems: floor.problems };

    if (id) {
      await db
        .update(plans)
        .set({ ...parsed.data, description: parsed.data.description ?? null })
        .where(and(eq(plans.id, id), eq(plans.agencyId, session.agencyId)));
    } else {
      const existing = await db.query.plans.findMany({ where: eq(plans.agencyId, session.agencyId), columns: { id: true } });
      await db.insert(plans).values({ ...parsed.data, description: parsed.data.description ?? null, agencyId: session.agencyId, isDefault: existing.length === 0 });
    }
    revalidatePath("/app/agency/plans");
    revalidatePath("/");
    return { ok: true };
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

export async function setDefaultPlan(formData: FormData) {
  const session = await agencySession();
  const id = String(formData.get("id") ?? "");
  await db.update(plans).set({ isDefault: false }).where(eq(plans.agencyId, session.agencyId));
  await db.update(plans).set({ isDefault: true, active: true }).where(and(eq(plans.id, id), eq(plans.agencyId, session.agencyId)));
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
