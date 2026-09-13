import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import type { CallerTag, Policy, Rule, ScheduleState, Step } from "./policy";

/* -------------------------------------------------------------------------
 * Rule selection (pure)
 * ---------------------------------------------------------------------- */

export type EvalContext = {
  schedule: ScheduleState;
  caller: CallerTag;
  ivrDigit?: string;
};

function ruleMatches(rule: Rule, ctx: EvalContext): boolean {
  const w = rule.when;
  if (w.schedule && w.schedule !== ctx.schedule) return false;
  if (w.caller && w.caller !== ctx.caller) return false;
  if (w.ivr && w.ivr !== ctx.ivrDigit) return false;
  return true;
}

/**
 * The ordered steps to run for this call. A blocked caller with no explicit
 * rule is always rejected; a policy with no matching rule falls to voicemail.
 */
export function resolveSteps(policy: Policy, ctx: EvalContext): { ruleIndex: number; steps: Step[] } {
  const idx = policy.rules.findIndex((r) => ruleMatches(r, ctx));
  if (idx >= 0) return { ruleIndex: idx, steps: policy.rules[idx].then };
  if (ctx.caller === "blocked") return { ruleIndex: -1, steps: [{ type: "reject" }] };
  return { ruleIndex: -1, steps: [{ type: "voicemail" }] };
}

/* -------------------------------------------------------------------------
 * Step paths: "2" = steps[2]; "2/1/0" = steps[2] (an ivr).options["1"][0]
 * ---------------------------------------------------------------------- */

export function stepAt(steps: Step[], path: string): Step | null {
  const parts = path.split("/");
  let list: Step[] = steps;
  let step: Step | null = null;
  for (let i = 0; i < parts.length; i++) {
    const idx = Number(parts[i]);
    if (i % 2 === 0) {
      step = list[idx] ?? null;
      if (!step) return null;
    } else {
      if (!step || step.type !== "ivr") return null;
      const branch = step.options[parts[i]];
      if (!branch) return null;
      list = branch;
    }
  }
  return step;
}

/** Path of the step that runs after `path` completes without a conversation. Null = nothing left. */
export function nextPath(steps: Step[], path: string): string | null {
  const parts = path.split("/");
  // Try the next sibling at this level; if none, climb out of the ivr branch
  // and continue after the ivr step itself.
  for (let depth = parts.length; depth >= 1; depth -= 2) {
    const prefix = parts.slice(0, depth - 1);
    const idx = Number(parts[depth - 1]);
    const candidate = [...prefix, String(idx + 1)].join("/");
    if (stepAt(steps, candidate)) return candidate;
  }
  return null;
}

/** First step inside an ivr option branch. */
export function ivrOptionPath(ivrPath: string, digit: string): string {
  return `${ivrPath}/${digit}/0`;
}

/* -------------------------------------------------------------------------
 * Signed cursor carried in every action URL so a webhook can resume the call
 * ---------------------------------------------------------------------- */

export type Cursor = {
  /** tb.calls.id */
  c: string;
  /** rule index (-1 = synthetic) */
  r: number;
  /** step path, or "transfer" for an AI-initiated transfer */
  p: string;
  /** ivr attempts so far */
  a?: number;
};

function signingKey(): Buffer {
  const secret = env.ROUTING_SIGNING_SECRET ?? env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("ROUTING_SIGNING_SECRET (or CREDENTIALS_ENCRYPTION_KEY) must be set to sign routing cursors");
  return createHmac("sha256", "tb-routing-cursor").update(secret).digest();
}

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signCursor(cursor: Cursor): string {
  const payload = b64url(Buffer.from(JSON.stringify(cursor)));
  const sig = b64url(createHmac("sha256", signingKey()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyCursor(token: string | null | undefined): Cursor | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = b64url(createHmac("sha256", signingKey()).update(payload).digest());
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Cursor;
    if (typeof obj.c !== "string" || typeof obj.p !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}
