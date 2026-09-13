import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers } from "@/db/schema";
import { canManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import type { NumberType } from "@/lib/twilio/numbers";
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
  const bundles = await bundlesFor(client.id);
  const approvedTypes = bundles.filter((b) => b.status === "twilio-approved").map((b) => b.numberType);
  const pendingTypes = bundles.filter((b) => b.status === "pending-review" || b.status === "in-review").map((b) => b.numberType);
  // Prefill from the most recent registration so a second type is one click.
  const last = bundles[0]?.submitted ?? {};

  // Back from Stripe Checkout (Phase 3): confirm the card and carry on.
  let resume: ResumeState | undefined;
  if (sp.checkout && sp.numberId) {
    const endUserType = sp.endUserType === "individual" ? "individual" : "business";
    const row = await db.query.numbers.findFirst({ where: eq(numbers.id, sp.numberId) });
    if (row && row.clientId === client.id) {
      const chosen = { e164: row.e164, locality: row.locality, type: row.type, friendly: row.e164 };
      if (sp.checkout === "cancel") resume = { numberId: row.id, chosen, endUserType, active: false, spec: null, cancelled: true };
      else {
        try {
          const r = await resumeAfterCheckout(row.id, endUserType);
          resume = { numberId: r.numberId, chosen, endUserType, active: r.active, spec: r.spec };
        } catch (e) {
          resume = { numberId: row.id, chosen, endUserType, active: false, spec: null, error: (e as Error).message };
        }
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Buy a number</h1>
        <p className="text-sm text-slate-500">Pick the number, tell Ofcom who owns it, and it goes live as soon as the registration is approved.</p>
      </div>
      <BuyFlow
        clientName={client.name}
        contactEmail={session.email}
        approvedTypes={approvedTypes}
        pendingTypes={pendingTypes}
        prefill={last}
        initialType={initialType}
        initialContains={initialContains}
        resume={resume}
      />
    </div>
  );
}
