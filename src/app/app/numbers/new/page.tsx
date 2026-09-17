import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers } from "@/db/schema";
import { canManage } from "@/lib/auth";
import { defaultPlanFor } from "@/lib/billing/plans";
import { currentClient } from "@/lib/clients";
import type { NumberType } from "@/lib/twilio/numbers";
import { getBusinessProfile, typesCoveredBy } from "@/lib/twilio/business";
import { bundlesFor } from "@/lib/twilio/regulatory";
import { resumeAfterCheckout } from "../actions";
import { BuyFlow, type ResumeState } from "./buy-flow";

export const metadata = { title: "Buy a number" };

const TYPES: NumberType[] = ["local", "national", "tollfree", "mobile"];

export default async function NewNumberPage({
  searchParams,
}: {
  searchParams: Promise<{ number?: string; type?: string; checkout?: string; numberId?: string; endUserType?: string }>;
}) {
  const sp = await searchParams;
  const { session, client } = await currentClient();
  if (!client) return null;
  if (!canManage(session)) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">Buying numbers is for admins</h1>
        <p className="mt-2 text-sm text-slate-600">Ask an admin of {client.name} to buy the number, or to make you an admin from Settings.</p>
      </div>
    );
  }
  // Preselect from the storefront (/signup?number=&type=): show that number first.
  const initialType = sp.type && (TYPES as string[]).includes(sp.type) ? (sp.type as NumberType) : undefined;
  const initialContains = initialType && sp.number && /^\+44\d{9,10}$/.test(sp.number) ? sp.number : undefined;
  const [bundles, profile, plan] = await Promise.all([bundlesFor(client.id), getBusinessProfile(client.id), defaultPlanFor(session.agencyId)]);
  const pricing = plan
    ? { currency: plan.currency, carrier: plan.carrierMonthlyPence, hosting: plan.hostingMonthlyPence, includedMinutes: plan.includedMinutes, perMinute: plan.perMinutePence, surchargeBps: plan.surchargeBps }
    : undefined;
  // A local registration covers 03 numbers too, so National shows as registered alongside Local.
  const approvedTypes = bundles.filter((b) => b.status === "twilio-approved").flatMap((b) => typesCoveredBy(b.numberType));
  const pendingTypes = bundles.filter((b) => b.status === "pending-review" || b.status === "in-review").flatMap((b) => typesCoveredBy(b.numberType)).filter((t) => !approvedTypes.includes(t));

  // Back from Stripe Checkout, or back from /app/business with a reserved
  // number: confirm the card (a no-op when already on file) and carry on.
  let resume: ResumeState | undefined;
  if (sp.numberId) {
    const endUserType = profile?.endUserType === "individual" ? "individual" : sp.endUserType === "individual" ? "individual" : "business";
    const row = await db.query.numbers.findFirst({ where: eq(numbers.id, sp.numberId) });
    if (row && row.clientId === client.id) {
      const chosen = { e164: row.e164, locality: row.locality, type: row.type, friendly: row.e164 };
      if (sp.checkout === "cancel") resume = { numberId: row.id, chosen, endUserType, active: false, cancelled: true };
      else {
        try {
          const r = await resumeAfterCheckout(row.id, endUserType);
          resume = { numberId: r.numberId, chosen, endUserType, active: r.active, needsProfile: r.needsProfile, registration: r.registration };
          if (r.checkoutUrl) resume = { ...resume, cancelled: true, error: "Add a card to continue." };
        } catch (e) {
          resume = { numberId: row.id, chosen, endUserType, active: false, error: (e as Error).message };
        }
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Buy a number</h1>
        <p className="text-sm text-slate-500">Pick the number; it is registered to your business from the details you saved once, and goes live as soon as Ofcom approves.</p>
      </div>
      <BuyFlow
        clientName={client.name}
        contactEmail={session.email}
        approvedTypes={approvedTypes}
        pendingTypes={pendingTypes}
        hasProfile={!!profile}
        initialType={initialType}
        initialContains={initialContains}
        resume={resume}
        pricing={pricing}
      />
    </div>
  );
}
