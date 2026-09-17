import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers } from "@/db/schema";
import { canManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { StatusPill, formatUk, typeLabel } from "@/lib/format";
import { reservedContext, reservedReason } from "@/lib/numbers/reserved";
import { bundlesFor } from "@/lib/twilio/regulatory";
import { releaseNumberAction } from "./actions";
import { ReleaseButton } from "./release-button";

export const metadata = { title: "Numbers" };

export default async function NumbersPage() {
  const { client, session } = await currentClient();
  if (!client) return null;
  const manage = canManage(session);

  const [rows, bundles] = await Promise.all([
    db.query.numbers.findMany({ where: and(eq(numbers.clientId, client.id), ne(numbers.status, "released")), orderBy: [desc(numbers.createdAt)] }),
    bundlesFor(client.id),
  ]);
  const pending = bundles.filter((b) => b.status === "pending-review" || b.status === "in-review");
  const rejected = bundles.filter((b) => b.status === "twilio-rejected");
  const reserved = rows.some((r) => r.status === "reserved") ? await reservedContext(client.id) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Numbers</h1>
          <p className="text-sm text-slate-500">Every number {client.name} owns, and where it stands.</p>
        </div>
        {manage && (
          <Link href="/app/numbers/new" className="btn-primary">
            Buy a number
          </Link>
        )}
      </div>

      {pending.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <strong>Ofcom verification in progress.</strong> Twilio is reviewing your {pending.map((b) => typeLabel(b.numberType).toLowerCase()).join(" and ")} registration. This
          usually completes within 24 hours; reserved numbers go live automatically the moment it is approved.
        </div>
      )}
      {rejected.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
          <strong>A registration was rejected.</strong> {rejected[0].failureReason ?? "Check the email from Twilio for the reason."}{" "}
          <Link href="/app/numbers/new" className="underline">
            Start again
          </Link>{" "}
          with corrected details.
        </div>
      )}

      <div className="card">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-600">
            No numbers yet.{" "}
            <Link href="/app/numbers/new" className="underline">
              Buy your first number
            </Link>
            .
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2">Number</th>
                <th className="pb-2">Type</th>
                <th className="pb-2">Status</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((n) => (
                <tr key={n.id}>
                  <td className="py-3">
                    <Link href={`/app/numbers/${n.id}`} className="font-medium tabular-nums hover:underline">
                      {formatUk(n.e164)}
                    </Link>
                    {n.label && <div className="text-xs text-slate-500">{n.label}</div>}
                  </td>
                  <td className="py-3 text-slate-600">
                    {typeLabel(n.type)}
                    {n.locality ? ` · ${n.locality}` : ""}
                  </td>
                  <td className="py-3">
                    <StatusPill status={n.status} />
                    {n.status === "reserved" && reserved && <div className="mt-1 text-xs text-slate-500">{reservedReason(reserved, n.type).short}</div>}
                    {n.status === "verifying" && <div className="mt-1 text-xs text-slate-500">Ofcom verification usually completes within 24h</div>}
                  </td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-3">
                      <Link href={`/app/routing/${n.id}`} className="text-slate-600 hover:text-slate-900">
                        Routing
                      </Link>
                      {manage && (
                        <form action={releaseNumberAction}>
                          <input type="hidden" name="numberId" value={n.id} />
                          <ReleaseButton label={formatUk(n.e164)} />
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

