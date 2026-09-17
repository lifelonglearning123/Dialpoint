import { getSubscription, subscriptionAllowsNumbers } from "@/lib/billing/subscription";
import { typeLabel } from "@/lib/format";
import { getBusinessProfile, registrableTypeFor, registrationStatus } from "@/lib/twilio/business";
import type { NumberType } from "@/lib/twilio/numbers";

/**
 * Why a reserved number has not gone live yet, in the order the buy flow
 * checks things: card on file first, then the Ofcom registration for the
 * number's type. Every type (including National 03) has its own registration.
 */
export type ReservedReason = {
  kind: "payment" | "ready" | "pending" | "rejected" | "register" | "unregistered";
  /** One line for lists. */
  short: string;
  /** A sentence for the detail page. */
  long: string;
};

export type ReservedContext = { paid: boolean; hasProfile: boolean; registrations: Awaited<ReturnType<typeof registrationStatus>> };

/** Load once per page; `reservedReason` is then pure per number. */
export async function reservedContext(clientId: string): Promise<ReservedContext> {
  const [sub, registrations, profile] = await Promise.all([getSubscription(clientId), registrationStatus(clientId), getBusinessProfile(clientId)]);
  return { paid: subscriptionAllowsNumbers(sub), hasProfile: !!profile, registrations };
}

export function reservedReason(ctx: ReservedContext, type: NumberType): ReservedReason {
  const reg = ctx.registrations.find((r) => r.type === registrableTypeFor(type));
  const approved = reg?.state === "twilio-approved";
  const regLabel = typeLabel(registrableTypeFor(type)).toLowerCase();

  if (!ctx.paid) {
    return {
      kind: "payment",
      short: "Waiting for a card on file",
      long: approved
        ? `Held for you. Your ${regLabel} registration is already approved, so the number goes live as soon as a card is added.`
        : "Held for you. Add a card to continue; the Ofcom registration follows automatically.",
    };
  }
  if (approved) {
    return { kind: "ready", short: "Approved, ready to activate", long: `Your ${regLabel} registration is approved. Activate the number now.` };
  }
  if (reg?.state === "pending-review" || reg?.state === "in-review") {
    return { kind: "pending", short: "Waiting for Ofcom verification", long: "Ofcom verification usually completes within 24 hours; the number goes live automatically on approval." };
  }
  if (reg?.state === "twilio-rejected") {
    return { kind: "rejected", short: "Registration rejected", long: "The Ofcom registration was rejected. Correct your business details and register again." };
  }
  if (ctx.hasProfile) {
    return {
      kind: "register",
      short: `Needs a ${regLabel} registration`,
      long: `${typeLabel(type)} numbers need their own Ofcom registration. Your business details are already saved, so it can be submitted now; the number goes live automatically on approval, usually within 24 hours.`,
    };
  }
  return { kind: "unregistered", short: "Business details needed", long: "Complete your business details under Business to register this number type." };
}
