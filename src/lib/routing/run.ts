import { registerAi } from "./ai";
import { appendTrace } from "./calls";
import type { CallContext } from "./context";
import { nextPath, resolveSteps, signCursor, stepAt, type Cursor, type EvalContext } from "./engine";
import type { Step } from "./policy";
import { dialRetell, forwardRaw, hangup, ivr, reject, ringHumans, voicemail, type RingTarget, type Twiml } from "./twiml";

export type RunState = {
  ctx: CallContext;
  callId: string;
  twilioCallSid: string;
  from: string;
  to: string;
  callerName: string | null;
  evalCtx: EvalContext;
  ruleIndex: number;
  steps: Step[];
};

/** Resolve the rule for a fresh call and build the run state. */
export function startRun(base: Omit<RunState, "ruleIndex" | "steps">): RunState {
  const { ruleIndex, steps } = resolveSteps(base.ctx.policy, base.evalCtx);
  return { ...base, ruleIndex, steps };
}

/** Re-create the run state for a call resumed from a cursor. */
export function resumeRun(base: Omit<RunState, "ruleIndex" | "steps">, cursor: Cursor): RunState {
  const rule = cursor.r >= 0 ? base.ctx.policy.rules[cursor.r] : null;
  if (rule) return { ...base, ruleIndex: cursor.r, steps: rule.then };
  return startRun(base);
}

function targetsFor(state: RunState, step: Extract<Step, { type: "ring_humans" }>): RingTarget[] {
  const wanted = step.targets && step.targets !== "all" ? new Set(step.targets) : null;
  const out: RingTarget[] = [];
  for (const t of state.ctx.targets) {
    if (!t.enabled) continue;
    if (wanted && !wanted.has(t.id)) continue;
    if (t.kind === "pstn") {
      // Never ring the phone the call is coming from: it would only reach its own voicemail.
      if (t.value === state.from) continue;
      out.push({ kind: "pstn", number: t.value });
    } else {
      out.push({ kind: "client", identity: `user:${t.profileId ?? t.value}` });
    }
  }
  return out;
}

function cursorFor(state: RunState, path: string, extra: Partial<Cursor> = {}): string {
  return signCursor({ c: state.callId, r: state.ruleIndex, p: path, ...extra });
}

/**
 * Produce the TwiML for the step at `path`. Steps that cannot run right now
 * (no targets, AI not linked, invalid) fall through to the next step so the
 * caller always ends somewhere sensible.
 */
export async function executeStep(state: RunState, path: string, attempt = 0): Promise<Twiml> {
  const step = stepAt(state.steps, path);
  if (!step) {
    await appendTrace(state.callId, "no_more_steps", { path });
    return hangup("Sorry, we couldn't take your call. Please try again later.");
  }
  const advance = async (why: string) => {
    await appendTrace(state.callId, "step_skipped", { path, type: step.type, why });
    const np = nextPath(state.steps, path);
    return np ? executeStep(state, np) : executeStep(state, "__end__");
  };

  switch (step.type) {
    case "reject": {
      await appendTrace(state.callId, "rejected", { path });
      return reject();
    }
    case "ring_humans": {
      const targets = targetsFor(state, step);
      if (targets.length === 0) return advance("no_targets");
      await appendTrace(state.callId, "ring_humans", { path, targets: targets.map((t) => (t.kind === "pstn" ? t.number : t.identity)).join(",") });
      return ringHumans({
        cursor: cursorFor(state, path),
        businessName: state.ctx.client.name,
        targets,
        timeoutSeconds: step.timeoutSeconds ?? 20,
        callerId: state.from.startsWith("+") ? state.from : state.to,
        whisper: step.whisper !== false,
        record: state.ctx.policy.record,
      });
    }
    case "forward_raw": {
      if (step.number === state.from) return advance("target_is_caller");
      await appendTrace(state.callId, "forward_raw", { path, number: step.number, whisper: String(step.whisper === true) });
      return forwardRaw({
        cursor: cursorFor(state, path),
        number: step.number,
        callerId: state.from.startsWith("+") ? state.from : state.to,
        timeoutSeconds: step.timeoutSeconds,
        whisper: step.whisper,
        businessName: state.ctx.client.name,
        record: state.ctx.policy.record,
      });
    }
    case "ai": {
      const reason =
        (step.reason as Parameters<typeof registerAi>[0]["reason"] | undefined) ??
        (path === "0" ? (state.evalCtx.schedule === "in_hours" ? "ai_first" : "after_hours") : "overflow");
      try {
        const { retellCallId, sipUri, agentId } = await registerAi({
          ctx: state.ctx,
          agentId: step.agentId,
          callId: state.callId,
          twilioCallSid: state.twilioCallSid,
          from: state.from,
          to: state.to,
          reason,
          callerName: state.callerName,
        });
        await appendTrace(state.callId, "ai_registered", { path, retellCallId, reason, agentId });
        return dialRetell({ cursor: cursorFor(state, path), sipUri, record: state.ctx.policy.record });
      } catch (e) {
        await appendTrace(state.callId, "ai_register_failed", { path, error: String(e).slice(0, 200) });
        return advance("ai_unavailable");
      }
    }
    case "ivr": {
      const repeats = step.repeats ?? 2;
      if (attempt > repeats) return advance("ivr_no_choice");
      await appendTrace(state.callId, "ivr", { path, attempt: String(attempt) });
      return ivr({ cursor: cursorFor(state, path, { a: attempt }), prompt: step.prompt, digits: Object.keys(step.options) });
    }
    case "voicemail": {
      await appendTrace(state.callId, "voicemail", { path });
      return voicemail({ cursor: cursorFor(state, path), businessName: state.ctx.client.name, greeting: step.greeting });
    }
  }
}

/** Ring the humans because the AI asked to transfer. */
export async function executeTransfer(state: RunState): Promise<Twiml | null> {
  const targets = targetsFor(state, { type: "ring_humans", targets: "all" });
  if (targets.length === 0) return null;
  await appendTrace(state.callId, "transfer_ring_humans", { targets: targets.map((t) => (t.kind === "pstn" ? t.number : t.identity)).join(",") });
  return ringHumans({
    cursor: cursorFor(state, "transfer"),
    businessName: state.ctx.client.name,
    targets,
    timeoutSeconds: 25,
    callerId: state.from.startsWith("+") ? state.from : state.to,
    whisper: true,
    transfer: true,
    record: state.ctx.policy.record,
  });
}
