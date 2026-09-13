export function formatUk(e164: string) {
  if (!e164.startsWith("+44")) return e164;
  const n = "0" + e164.slice(3);
  if (n.startsWith("02")) return `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`;
  if (n.startsWith("07") || n.startsWith("08") || n.startsWith("03")) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  return `${n.slice(0, 5)} ${n.slice(5)}`;
}

export function typeLabel(t: string) {
  return { local: "Local", national: "National 03", tollfree: "Freephone 0800", mobile: "Mobile" }[t] ?? t;
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    verifying: "bg-amber-50 text-amber-700 ring-amber-200",
    reserved: "bg-slate-100 text-slate-700 ring-slate-200",
    suspended: "bg-red-50 text-red-700 ring-red-200",
    released: "bg-slate-100 text-slate-500 ring-slate-200",
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${map[status] ?? map.reserved}`}>{status}</span>;
}

/** Kept out of component bodies so the React purity lint does not flag Date.now(). */
export function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400_000);
}
