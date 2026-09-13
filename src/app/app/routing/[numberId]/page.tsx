import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { numbers, routingPolicies } from "@/db/schema";
import { canManage, isAgency } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { formatUk, typeLabel } from "@/lib/format";
import { describePolicy, parsePolicy, TEMPLATE_LABELS, TEMPLATE_NAMES, type Policy, type TemplateName } from "@/lib/routing/policy";
import { savePolicy } from "../actions";
import { TemplateForm } from "./template-form";

export default async function EditRoutingPage({ params }: { params: Promise<{ numberId: string }> }) {
  const { numberId } = await params;
  const { client, session } = await currentClient();
  if (!client) return null;
  const manage = canManage(session);
  const number = await db.query.numbers.findFirst({ where: and(eq(numbers.id, numberId), eq(numbers.clientId, client.id), ne(numbers.status, "released")) });
  if (!number) notFound();
  const row = await db.query.routingPolicies.findFirst({ where: and(eq(routingPolicies.numberId, number.id), eq(routingPolicies.active, true)) });

  let current: Policy | null = null;
  try {
    current = row ? parsePolicy(row.policy) : null;
  } catch {
    current = null;
  }
  const template = (current?.template ?? "you_first") as TemplateName;
  const ring = current ? firstRingSeconds(current) : 20;
  const ivr = current ? firstIvr(current) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/app/routing" className="text-sm text-slate-500 hover:text-slate-900">
          ← Routing
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tabular-nums">{formatUk(number.e164)}</h1>
        <p className="text-sm text-slate-500">
          {number.label ?? typeLabel(number.type)}
          {row ? ` · routing version ${row.version}` : " · no routing saved yet"}
        </p>
      </div>

      {!manage && (
        <div className="card space-y-2">
          <h2 className="font-semibold">{current ? (TEMPLATE_LABELS[(current.template ?? "custom") as TemplateName]?.title ?? "Custom") : "Default: ring your phones, then voicemail"}</h2>
          <ul className="space-y-0.5 text-sm text-slate-600">
            {(current ? describePolicy(current) : []).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">Only admins of {client.name} can change routing.</p>
        </div>
      )}

      {manage && (
      <form action={savePolicy} className="space-y-6">
        <input type="hidden" name="numberId" value={number.id} />
        <TemplateForm
          templates={TEMPLATE_NAMES.filter((t) => t !== "custom").map((t) => ({ value: t, ...TEMPLATE_LABELS[t] }))}
          initialTemplate={template === "custom" ? "you_first" : template}
          initialRingSeconds={ring}
          initialAgentId={current?.aiAgentId ?? ""}
          initialIvr={ivr}
          isAgency={isAgency(session.role)}
          agencyName={session.agency.name}
        />
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary">
            Save routing
          </button>
          <Link href="/app/routing" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
      )}
    </div>
  );
}

function firstRingSeconds(p: Policy): number {
  for (const r of p.rules) for (const s of r.then) if (s.type === "ring_humans" && s.timeoutSeconds) return s.timeoutSeconds;
  return 20;
}

function firstIvr(p: Policy): { prompt: string; options: Record<string, "humans" | "ai" | "voicemail"> } | null {
  for (const r of p.rules)
    for (const s of r.then)
      if (s.type === "ivr") {
        const options: Record<string, "humans" | "ai" | "voicemail"> = {};
        for (const [d, steps] of Object.entries(s.options)) {
          const first = steps[0]?.type;
          options[d] = first === "ring_humans" ? "humans" : first === "ai" ? "ai" : "voicemail";
        }
        return { prompt: s.prompt, options };
      }
  return null;
}
