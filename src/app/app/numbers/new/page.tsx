import { currentClient } from "@/lib/clients";
import { bundlesFor } from "@/lib/twilio/regulatory";
import { BuyFlow } from "./buy-flow";

export const metadata = { title: "Buy a number" };

export default async function NewNumberPage() {
  const { session, client } = await currentClient();
  if (!client) return null;
  const bundles = await bundlesFor(client.id);
  const approvedTypes = bundles.filter((b) => b.status === "twilio-approved").map((b) => b.numberType);
  const pendingTypes = bundles.filter((b) => b.status === "pending-review" || b.status === "in-review").map((b) => b.numberType);
  // Prefill from the most recent registration so a second type is one click.
  const last = bundles[0]?.submitted ?? {};

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
      />
    </div>
  );
}
