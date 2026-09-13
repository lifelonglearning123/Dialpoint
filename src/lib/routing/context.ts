import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { calls, closures, contacts, humanTargets, numbers, routingPolicies } from "@/db/schema";
import { clients } from "@/db/shared";
import { parsePolicy, type CallerTag, type Policy } from "./policy";
import type { BusinessHours } from "./schedule";

export type NumberRow = typeof numbers.$inferSelect;
export type TargetRow = typeof humanTargets.$inferSelect;

export type CallContext = {
  number: NumberRow;
  client: { id: string; name: string; timezone: string; businessHours: BusinessHours };
  policyRow: { id: string } | null;
  policy: Policy;
  targets: TargetRow[];
  closures: string[];
};

const FALLBACK_POLICY: Policy = {
  version: 1,
  template: "custom",
  rules: [{ when: {}, then: [{ type: "ring_humans", targets: "all", timeoutSeconds: 20, whisper: true }, { type: "voicemail" }] }],
};

async function clientBits(clientId: string) {
  const [c, targets, cl] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, clientId), columns: { id: true, name: true, timezone: true, businessHours: true } }),
    db.query.humanTargets.findMany({ where: eq(humanTargets.clientId, clientId), orderBy: (t, { asc }) => [asc(t.priority), asc(t.createdAt)] }),
    db.query.closures.findMany({ where: eq(closures.clientId, clientId), columns: { date: true } }),
  ]);
  return { c, targets, closureDates: cl.map((x) => x.date) };
}

function safePolicy(raw: unknown): Policy {
  try {
    return parsePolicy(raw);
  } catch (e) {
    console.error("[routing] stored policy failed validation, using fallback", e);
    return FALLBACK_POLICY;
  }
}

/** Everything the engine needs for a call to `toE164`, or null if we don't own that number. */
export async function lookupNumber(toE164: string): Promise<CallContext | null> {
  const number = await db.query.numbers.findFirst({ where: and(eq(numbers.e164, toE164), ne(numbers.status, "released")) });
  if (!number) return null;
  const policyRow = await db.query.routingPolicies.findFirst({ where: and(eq(routingPolicies.numberId, number.id), eq(routingPolicies.active, true)) });
  const { c, targets, closureDates } = await clientBits(number.clientId);
  if (!c) return null;
  return {
    number,
    client: { id: c.id, name: c.name, timezone: c.timezone, businessHours: c.businessHours as BusinessHours },
    policyRow: policyRow ? { id: policyRow.id } : null,
    policy: policyRow ? safePolicy(policyRow.policy) : FALLBACK_POLICY,
    targets,
    closures: closureDates,
  };
}

/** Context for a call already in tb.calls (from a signed cursor). Uses the policy version the call started on. */
export async function contextForCall(callId: string) {
  const call = await db.query.calls.findFirst({ where: eq(calls.id, callId) });
  if (!call || !call.numberId) return null;
  const number = await db.query.numbers.findFirst({ where: eq(numbers.id, call.numberId) });
  if (!number) return null;
  const policyRow = call.policyId ? await db.query.routingPolicies.findFirst({ where: eq(routingPolicies.id, call.policyId) }) : null;
  const { c, targets, closureDates } = await clientBits(number.clientId);
  if (!c) return null;
  const ctx: CallContext = {
    number,
    client: { id: c.id, name: c.name, timezone: c.timezone, businessHours: c.businessHours as BusinessHours },
    policyRow: policyRow ? { id: policyRow.id } : null,
    policy: policyRow ? safePolicy(policyRow.policy) : FALLBACK_POLICY,
    targets,
    closures: closureDates,
  };
  return { call, ctx };
}

export async function callerTag(clientId: string, fromE164: string): Promise<{ tag: CallerTag; name: string | null }> {
  if (!fromE164 || !fromE164.startsWith("+")) return { tag: "unknown", name: null };
  const row = await db.query.contacts.findFirst({ where: and(eq(contacts.clientId, clientId), eq(contacts.e164, fromE164)) });
  if (!row) return { tag: "unknown", name: null };
  return { tag: row.tag, name: row.name };
}
