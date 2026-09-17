import { getSubscription, subscriptionAllowsNumbers } from "@/lib/billing/subscription";
import { typeLabel } from "@/lib/format";
import { registrableTypeFor, registrationStatus } from "@/lib/twilio/business";
import type { NumberType } from "@/lib/twilio/numbers";

/**
 * Why a reserved number has not gone live yet, in the order the buy flow
 * checks things: card on file first, then the Ofcom registration for the
 * number's type. 03 numbers are covered by the local registration, so a
 * national number never waits on a registration of its own.
 */
export type ReservedReason = {
  kind: "payment" | "ready" | "pending" | "rejected" | "unregistered";
  /** One line for lists. */
  short: string;
  /** A sentence for the detail page. */
  long: string;
};

export type ReservedContext = { paid: boolean; registrations: Awaited<ReturnType<typeof registrationStatus>> };

/** Load once per page; `reservedReason` is then pure per number. */
export async function reservedContext(clientId: string): Promise<ReservedContext> {
  const [sub, registrations] = await Promise.all([getSubscription(clientId), registrationStatus(clientId)]);
  return { paid: subscriptionAllowsNumbers(sub), registrations };
}

export function reservedReason(ctx: ReservedContext, type: NumberType): ReservedReason {
  const reg = ctx.registrations.find((r) => r.type === registrableTypeFor(type));
  const approved = reg?.state === "twilio-approved";
  const regLabel = typeLabel(registrableTypeFor(type)).toLowerCase();
  const covered = type === "national" ? ` (${regLabel} registration covers 03 numbers)` : "";

  if (!ctx.paid) {
    return {
      kind: "payment",
      short: "Waiting for a card on file",
      long: approved
        ? `Held for you. Your ${regLabel} registration is already approved${covered}, so the number goes live as soon as a card is added.`
        : "Held for you. Add a card to continue; the Ofcom registration follows automatically.",
    };
  }
  if (approved) {
    return { kind: "ready", short: "Approved, ready to activate", long: `Your ${regLabel} registration is approved${covered}. Activate the number now.` };
  }
  if (reg?.state === "pending-review" || reg?.state === "in-review") {
    return { kind: "pending", short: "Waiting for Ofcom verification", long: "Ofcom verification usually completes within 24 hours; the number goes live automatically on approval." };
  }
  if (reg?.state === "twilio-rejected") {
    return { kind: "rejected", short: "Registration rejected", long: "The Ofcom registration was rejected. Correct your business details and register again." };
  }
  return { kind: "unregistered", short: "Business details needed", long: "Complete your business details under Business to register this number type." };
}
