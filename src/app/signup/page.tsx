import Link from "next/link";
import { redirect } from "next/navigation";
import { formatUk, typeLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { resolveAgency } from "@/lib/tenancy/resolve";
import { SignupForm } from "./signup-form";

export const metadata = { title: "Get started" };
export const dynamic = "force-dynamic";

const TYPES = ["local", "national", "tollfree", "mobile"];

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ number?: string; type?: string; plan?: string }> }) {
  const sp = await searchParams;
  const agency = await resolveAgency();

  const number = sp.number && /^\+44\d{9,10}$/.test(sp.number) ? sp.number : null;
  const type = sp.type && TYPES.includes(sp.type) ? sp.type : null;
  const next = number && type ? `/app/numbers/new?number=${encodeURIComponent(number)}&type=${type}` : "/app/numbers/new";

  if (agency) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect(next);
  }
  const accent = agency?.brandPrimaryColor ?? "#0f172a";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {agency?.brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={agency.brandLogoUrl} alt={agency.name} className="h-12 w-12 rounded-xl object-contain" />
          ) : (
            <div className="h-12 w-12 rounded-xl" style={{ background: accent }} aria-hidden />
          )}
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Get started with {agency?.name ?? "your number"}</h1>
            <p className="mt-1 text-sm text-slate-500">Tell us about your business, then choose your number.</p>
          </div>
        </div>

        {number && type && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
            <span className="text-slate-500">Your chosen number</span>
            <div className="font-medium tabular-nums text-slate-900">
              {formatUk(number)} <span className="text-xs font-normal text-slate-500">({typeLabel(type)})</span>
            </div>
            <span className="text-xs text-slate-500">Held for you once you finish signing up; availability is re-checked at purchase.</span>
          </div>
        )}

        <div className="rounded-2xl bg-white p-7 shadow-sm ring-1 ring-slate-200">
          {!agency ? <p className="text-sm text-slate-600">This domain is not configured for any workspace yet.</p> : <SignupForm next={next} accent={accent} />}
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          <Link href="/" className="hover:text-slate-900">
            ← Back
          </Link>
        </p>
      </div>
    </main>
  );
}
