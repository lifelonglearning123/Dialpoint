import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveAgency } from "@/lib/tenancy/resolve";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const agency = await resolveAgency();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && agency && !sp.error) redirect(sp.next && sp.next.startsWith("/") ? sp.next : "/app");

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-16">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          {agency?.brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={agency.brandLogoUrl} alt={agency.name} className="h-14 w-14 rounded-xl object-contain" />
          ) : (
            <div className="h-14 w-14 rounded-xl" style={{ background: agency?.brandPrimaryColor ?? "#0f172a" }} aria-hidden />
          )}
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{agency?.name ?? "Phone numbers"}</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to manage your numbers and call routing</p>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-7 shadow-sm ring-1 ring-slate-200">
          {!agency ? (
            <p className="text-sm text-slate-600">This domain is not configured for any workspace yet.</p>
          ) : (
            <>
              {sp.error && <div className="mb-5 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{sp.error}</div>}
              <LoginForm next={sp.next} />
            </>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          Same account as your {agency?.name ?? "agency"} AI receptionist dashboard.
        </p>
      </div>
    </main>
  );
}
