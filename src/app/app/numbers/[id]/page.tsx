import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers, regulatoryBundles } from "@/db/schema";
import { currentClient } from "@/lib/clients";
import { StatusPill, formatUk, typeLabel } from "@/lib/format";
import { activateNumberAction, releaseNumberAction, updateNumberLabelAction } from "../actions";
import { ReleaseButton } from "../release-button";

export default async function NumberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { client } = await currentClient();
  if (!client) return null;

  const n = await db.query.numbers.findFirst({ where: and(eq(numbers.id, id), eq(numbers.clientId, client.id)) });
  if (!n) notFound();

  const bundle = n.bundleId
    ? await db.query.regulatoryBundles.findFirst({ where: eq(regulatoryBundles.id, n.bundleId) })
    : await db.query.regulatoryBundles.findFirst({
        where: and(eq(regulatoryBundles.clientId, client.id), eq(regulatoryBundles.numberType, n.type)),
        orderBy: (b, { desc }) => [desc(b.createdAt)],
      });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <Link href="/app/numbers" className="text-sm text-slate-500 hover:text-slate-900">
            ← Numbers
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tabular-nums">{formatUk(n.e164)}</h1>
          <p className="text-sm text-slate-500">
            {typeLabel(n.type)}
            {n.locality ? ` · ${n.locality}` : ""}
          </p>
        </div>
        <Link href={`/app/routing/${n.id}`} className="btn-primary">
          Routing
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card space-y-3">
          <h2 className="font-semibold">Status</h2>
          <div className="flex items-center gap-3">
            <StatusPill status={n.status} />
            <span className="text-sm text-slate-600">
              {n.status === "active" && n.activatedAt && `Live since ${n.activatedAt.toLocaleDateString("en-GB")}`}
              {n.status === "reserved" && "Reserved; goes live when the Ofcom registration is approved"}
              {n.status === "verifying" && "Ofcom verification usually completes within 24h"}
              {n.status === "suspended" && "Suspended for non-payment; calls are not connecting"}
            </span>
          </div>
          {bundle && (
            <div className="rounded-md bg-slate-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Ofcom registration ({typeLabel(bundle.numberType).toLowerCase()})</span>
                <span className="font-medium">{bundle.status.replace(/-/g, " ")}</span>
              </div>
              {bundle.submittedAt && <div className="mt-1 text-xs text-slate-500">Submitted {bundle.submittedAt.toLocaleString("en-GB")}</div>}
              {bundle.failureReason && <div className="mt-2 text-xs text-red-700">{bundle.failureReason}</div>}
            </div>
          )}
          {n.status === "reserved" && bundle?.status === "twilio-approved" && (
            <form action={activateNumberAction}>
              <input type="hidden" name="numberId" value={n.id} />
              <button type="submit" className="btn-secondary">
                Activate now
              </button>
            </form>
          )}
        </section>

        <section className="card space-y-3">
          <h2 className="font-semibold">Label</h2>
          <form action={updateNumberLabelAction} className="flex gap-2">
            <input type="hidden" name="numberId" value={n.id} />
            <input name="label" defaultValue={n.label ?? ""} placeholder="e.g. Main line, Sales, Website" className="input" maxLength={60} />
            <button type="submit" className="btn-secondary">
              Save
            </button>
          </form>
          <p className="text-xs text-slate-500">Shown in the whisper (&ldquo;Call for &hellip;&rdquo;) and in the call log.</p>
        </section>
      </div>

      {n.status !== "released" && (
        <section className="card">
          <h2 className="font-semibold">Danger zone</h2>
          <p className="mt-1 text-sm text-slate-600">Releasing gives the number back to the carrier. It stops the monthly charge and cannot be undone.</p>
          <form action={releaseNumberAction} className="mt-3">
            <input type="hidden" name="numberId" value={n.id} />
            <ReleaseButton label={formatUk(n.e164)} />
          </form>
        </section>
      )}
    </div>
  );
}
