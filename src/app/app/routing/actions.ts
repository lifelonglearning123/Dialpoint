"use server";

import { and, asc, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db/client";
import { closures, humanTargets, numbers, routingPolicies } from "@/db/schema";
import { clients } from "@/db/shared";
import { requireManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { clientAgents } from "@/lib/routing/agents";
import { ANSWER_MODES, parsePolicy, policyAgentIds, simplePolicy, toE164, type AnswerMode, type PeriodRoute } from "@/lib/routing/policy";

const e164 = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use international format, e.g. +447700900123");

async function ctx() {
  const { session, client } = await currentClient();
  if (!client) throw new Error("No business selected.");
  // Every action in this file changes routing; client users are read-only.
  requireManage(session);
  return { session, client };
}

/* ---------------------------------------------------------------- hours */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export async function saveBusinessHours(formData: FormData) {
  const { client } = await ctx();
  const hours: Record<string, { start: string; end: string } | null> = {};
  for (const d of DAYS) {
    const open = formData.get(`${d}_open`) === "on";
    const start = String(formData.get(`${d}_start`) ?? "");
    const end = String(formData.get(`${d}_end`) ?? "");
    hours[d] = open && /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) ? { start, end } : null;
  }
  const timezone = String(formData.get("timezone") ?? "Europe/London");
  await db
    .update(clients)
    .set({ businessHours: hours as Record<string, { start: string; end: string }>, timezone })
    .where(eq(clients.id, client.id));
  revalidatePath("/app/routing");
}

/* ------------------------------------------------------------- closures */

export async function addClosure(formData: FormData) {
  const { client } = await ctx();
  const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().trim().min(1).max(80) }).safeParse({
    date: formData.get("date"),
    label: formData.get("label"),
  });
  if (!parsed.success) return;
  await db.insert(closures).values({ clientId: client.id, ...parsed.data }).onConflictDoNothing();
  revalidatePath("/app/routing");
}

export async function removeClosure(formData: FormData) {
  const { client } = await ctx();
  const id = String(formData.get("id") ?? "");
  await db.delete(closures).where(and(eq(closures.id, id), eq(closures.clientId, client.id)));
  revalidatePath("/app/routing");
}

/* -------------------------------------------------------------- targets */

async function nextPriority(clientId: string) {
  const rows = await db.query.humanTargets.findMany({ where: eq(humanTargets.clientId, clientId), columns: { priority: true } });
  return rows.reduce((m, r) => Math.max(m, r.priority), -1) + 1;
}

export async function addPhoneTarget(formData: FormData) {
  const { client } = await ctx();
  const parsed = z.object({ label: z.string().trim().min(1).max(60), number: e164 }).safeParse({ label: formData.get("label"), number: formData.get("number") });
  if (!parsed.success) return;
  await db.insert(humanTargets).values({
    clientId: client.id,
    kind: "pstn",
    value: parsed.data.number,
    label: parsed.data.label,
    priority: await nextPriority(client.id),
  });
  revalidatePath("/app/routing");
}

export async function addBrowserTarget() {
  const { session, client } = await ctx();
  const existing = await db.query.humanTargets.findFirst({
    where: and(eq(humanTargets.clientId, client.id), eq(humanTargets.kind, "client"), eq(humanTargets.profileId, session.profileId)),
  });
  if (existing) return;
  await db.insert(humanTargets).values({
    clientId: client.id,
    kind: "client",
    value: session.profileId,
    profileId: session.profileId,
    label: `${session.fullName ?? session.email} (browser)`,
    priority: await nextPriority(client.id),
  });
  revalidatePath("/app/routing");
}

export async function toggleTarget(formData: FormData) {
  const { client } = await ctx();
  const id = String(formData.get("id") ?? "");
  const row = await db.query.humanTargets.findFirst({ where: and(eq(humanTargets.id, id), eq(humanTargets.clientId, client.id)) });
  if (!row) return;
  await db.update(humanTargets).set({ enabled: !row.enabled }).where(eq(humanTargets.id, id));
  revalidatePath("/app/routing");
}

export async function deleteTarget(formData: FormData) {
  const { client } = await ctx();
  const id = String(formData.get("id") ?? "");
  await db.delete(humanTargets).where(and(eq(humanTargets.id, id), eq(humanTargets.clientId, client.id)));
  revalidatePath("/app/routing");
}

export async function moveTarget(formData: FormData) {
  const { client } = await ctx();
  const id = String(formData.get("id") ?? "");
  const dir = String(formData.get("dir") ?? "up");
  const rows = await db.query.humanTargets.findMany({ where: eq(humanTargets.clientId, client.id), orderBy: [asc(humanTargets.priority), asc(humanTargets.createdAt)] });
  const i = rows.findIndex((r) => r.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  const order = [...rows];
  [order[i], order[j]] = [order[j], order[i]];
  await Promise.all(order.map((r, idx) => db.update(humanTargets).set({ priority: idx }).where(eq(humanTargets.id, r.id))));
  revalidatePath("/app/routing");
}

/* --------------------------------------------------------------- policy */

const PERIODS = [
  { prefix: "in", label: "Office hours" },
  { prefix: "out", label: "Outside office hours" },
] as const;

/** One period's choice from the form, or an error message for the user. */
function readPeriod(formData: FormData, prefix: string, ownNumber: string, agentIds: Set<string>): PeriodRoute | string {
  const mode = String(formData.get(`${prefix}_mode`) ?? "") as AnswerMode;
  if (!ANSWER_MODES.includes(mode)) return "choose how calls are answered.";
  const ring = Number(formData.get(`${prefix}_ringSeconds`));
  const route: PeriodRoute = { mode, ringSeconds: Math.min(120, Math.max(5, Math.round(ring) || (mode === "forward" ? 30 : 20))) };
  if (mode !== "ai") {
    const to = toE164(String(formData.get(`${prefix}_forwardTo`) ?? ""));
    if (!to) return "enter the number to forward to, e.g. 07700 900123 or +447700900123.";
    if (to === ownNumber) return "a number can't forward to itself.";
    route.forwardTo = to;
  }
  if (mode !== "forward") {
    const agentId = String(formData.get(`${prefix}_agentId`) ?? "");
    if (!agentIds.has(agentId)) return "choose the AI agent.";
    route.agentId = agentId;
  }
  return route;
}

export async function savePolicy(formData: FormData) {
  const { session, client } = await ctx();
  const numberId = String(formData.get("numberId") ?? "");
  const number = await db.query.numbers.findFirst({ where: and(eq(numbers.id, numberId), eq(numbers.clientId, client.id), ne(numbers.status, "released")) });
  if (!number) throw new Error("Number not found.");
  const current = await db.query.routingPolicies.findFirst({ where: and(eq(routingPolicies.numberId, numberId), eq(routingPolicies.active, true)) });

  // Agency staff and the client's admins both choose the agent, from the
  // client's own Retell agents in Signal. An agent the number already uses
  // stays selectable even if it is not in that list.
  let currentAgents: string[] = [];
  try {
    currentAgents = current ? policyAgentIds(parsePolicy(current.policy)) : [];
  } catch {
    currentAgents = [];
  }
  const agentIds = new Set([...(await clientAgents(client.id)).filter((a) => a.platform === "retell").map((a) => a.id), ...currentAgents]);

  const routes: PeriodRoute[] = [];
  for (const period of PERIODS) {
    const r = readPeriod(formData, period.prefix, number.e164, agentIds);
    if (typeof r === "string") redirect(`/app/routing/${numberId}?error=${encodeURIComponent(`${period.label}: ${r}`)}`);
    routes.push(r);
  }
  const record = formData.get("record") === "on";
  const policy = parsePolicy(
    simplePolicy({ inHours: routes[0], outOfHours: routes[1] }, { record, announceRecording: record && formData.get("announce") === "on" }),
  );

  await db.transaction(async (tx) => {
    if (current) await tx.update(routingPolicies).set({ active: false }).where(eq(routingPolicies.id, current.id));
    await tx.insert(routingPolicies).values({
      numberId,
      version: (current?.version ?? 0) + 1,
      template: "simple",
      policy,
      active: true,
      createdBy: session.profileId,
    });
  });
  revalidatePath("/app/routing");
  redirect("/app/routing?saved=1");
}
