import Link from "next/link";
import { canManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { getBusinessProfile, registrationStatus } from "@/lib/twilio/business";
import { getRegulationSpec, type EndUserType } from "@/lib/twilio/regulatory";
import { BusinessForm, RegistrationCards } from "./business-form";

export const metadata = { title: "Business details" };

export default async function BusinessPage({ searchParams }: { searchParams: Promise<{ return?: string }> }) {
  const sp = await searchParams;
  const { session, client } = await currentClient();
  if (!client) return null;
  const manage = canManage(session);
  const returnTo = sp.return && sp.return.startsWith("/app") ? sp.return : null;

  const profile = await getBusinessProfile(client.id);
  const endUserType: EndUserType = profile?.endUserType === "individual" ? "individual" : "business";
  const [spec, registrations] = await Promise.all([getRegulationSpec("GB", "local", endUserType).catch(() => null), registrationStatus(client.id)]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Business details</h1>
        <p className="text-sm text-slate-500">
          UK numbers must be registered to their owner under Ofcom rules. Enter {client.name}&apos;s details once here; every number you buy afterwards uses them.
        </p>
      </div>

      {returnTo && (
        <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          You&apos;re here from buying a number. Save your details, register the number type below, then{" "}
          <Link href={returnTo} className="font-medium underline">
            continue with your number
          </Link>
          .
        </div>
      )}

      {!manage ? (
        <div className="card text-sm text-slate-600">Only admins of {client.name} can change business details.</div>
      ) : !spec ? (
        <div className="card text-sm text-red-700">Could not load Ofcom&apos;s requirements from Twilio. Check the Twilio master credentials and try again.</div>
      ) : (
        <BusinessForm
          spec={spec}
          endUserType={endUserType}
          attributes={profile?.attributes ?? {}}
          address={profile?.address ?? null}
          contactEmail={profile?.contactEmail ?? session.email}
          clientName={client.name}
          hasProfile={!!profile}
        />
      )}

      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold">Ofcom registrations</h2>
          <p className="mt-1 text-sm text-slate-600">
            One registration per number type, done once. Twilio reviews it, usually within 24 hours, and numbers of that type go live automatically on approval.
          </p>
        </div>
        <RegistrationCards registrations={registrations} canManage={manage} hasProfile={!!profile} endUserType={endUserType} returnTo={returnTo} />
      </section>
    </div>
  );
}
