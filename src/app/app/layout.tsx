import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { isAgency } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { switchClient } from "./actions";

const NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/numbers", label: "Numbers" },
  { href: "/app/routing", label: "Routing" },
  { href: "/app/calls", label: "Calls" },
  { href: "/app/softphone", label: "Softphone" },
  { href: "/app/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, client, clients } = await currentClient();
  const agency = session.agency;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            {agency.brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agency.brandLogoUrl} alt={agency.name} className="h-8 w-8 rounded-md object-contain" />
            ) : (
              <div className="h-8 w-8 rounded-md" style={{ background: agency.brandPrimaryColor ?? "#0f172a" }} />
            )}
            <div className="leading-tight">
              <div className="text-sm font-semibold">{agency.name}</div>
              <div className="text-xs text-slate-500">Phone numbers</div>
            </div>
          </div>
          <nav className="hidden gap-1 md:flex">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {clients.length > 1 || isAgency(session.role) ? (
              <form action={switchClient}>
                <select
                  name="clientId"
                  defaultValue={client?.id ?? ""}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="ml-2 text-xs text-slate-500 hover:text-slate-900">
                  Switch
                </button>
              </form>
            ) : (
              <span className="text-sm text-slate-600">{client?.name}</span>
            )}
            <form action={signOut}>
              <button type="submit" className="text-xs text-slate-500 hover:text-slate-900">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        {client ? (
          children
        ) : (
          <div className="card">
            <h1 className="text-lg font-semibold">No business is linked to your account yet</h1>
            <p className="mt-2 text-sm text-slate-600">Ask {agency.name} to add you to a client, or create one from the agency console.</p>
          </div>
        )}
      </main>
    </div>
  );
}
