// In-memory route trace for the spike: every webhook hit is recorded per call so
// we can read back "what happened" at GET /api/voice/trace. Production keeps this
// in tb.calls.route_trace.

export type TraceEvent = {
  at: string;
  callSid: string;
  step: string;
  data: Record<string, string>;
};

const g = globalThis as unknown as { __spikeTrace?: TraceEvent[] };
const events: TraceEvent[] = (g.__spikeTrace ??= []);

export function trace(callSid: string, step: string, data: Record<string, string> = {}) {
  const ev = { at: new Date().toISOString(), callSid, step, data };
  events.push(ev);
  if (events.length > 2000) events.splice(0, events.length - 2000);
  console.log(`[voice] ${ev.at} ${callSid.slice(-6)} ${step}`, JSON.stringify(data));
  return ev;
}

export function readTrace(callSid?: string) {
  return callSid ? events.filter((e) => e.callSid === callSid) : events;
}

export function pick(form: FormData, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = form.get(k);
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}
