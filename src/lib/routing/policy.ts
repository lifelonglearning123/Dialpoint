import { z } from "zod";

/**
 * Routing policy: the JSON evaluated on every inbound call to a number.
 *
 *   { version: 1, template, settings?, record?, rules: [ { when, then: Step[] } ] }
 *
 * Rules are checked in order; the first whose `when` conditions ALL hold wins
 * (an empty `when` always matches, so put it last as the default). The winning
 * rule's steps run in order: a step that ends without a human/AI conversation
 * (no answer, busy, SIP failure, invalid IVR choice) falls through to the next.
 *
 * The routing editor writes `settings` (what the customer chose for office
 * hours and outside them) and derives `rules` from it with `simplePolicy`; the
 * engine only ever reads `rules`. Each `ai` step names its Retell agent;
 * `aiAgentId` is the older policy-wide agent, still honoured for policies
 * saved before per-step agents.
 */

export const scheduleStates = ["in_hours", "out_of_hours", "closed_day"] as const;
export type ScheduleState = (typeof scheduleStates)[number];
export const callerTags = ["vip", "blocked", "known", "unknown"] as const;
export type CallerTag = (typeof callerTags)[number];

export type Step =
  | { type: "ring_humans"; targets?: string[] | "all"; timeoutSeconds?: number; whisper?: boolean }
  | { type: "ai"; reason?: string; agentId?: string }
  | { type: "ivr"; prompt: string; options: Record<string, Step[]>; repeats?: number }
  | { type: "voicemail"; greeting?: string }
  | { type: "reject" }
  | { type: "forward_raw"; number: string; timeoutSeconds?: number; whisper?: boolean };

export type Rule = {
  when: { schedule?: ScheduleState; caller?: CallerTag; ivr?: string };
  then: Step[];
};

export const ANSWER_MODES = ["forward", "ai", "forward_then_ai"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

/** What happens to a call in one period (office hours, or outside them). */
export type PeriodRoute = { mode: AnswerMode; forwardTo?: string; agentId?: string; ringSeconds: number };
export type RouteSettings = { inHours: PeriodRoute; outOfHours: PeriodRoute };

export type Policy = {
  version: 1;
  template?: TemplateName;
  aiAgentId?: string;
  settings?: RouteSettings;
  /** Record every answered conversation (forwarded phone or AI). Voicemails are always recorded. */
  record?: boolean;
  /** With `record`, say "this call may be recorded" before anything else. */
  announceRecording?: boolean;
  rules: Rule[];
};

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "Use international format, e.g. +447700900123");

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ring_humans"),
      targets: z.union([z.array(z.string().uuid()), z.literal("all")]).optional(),
      timeoutSeconds: z.number().int().min(5).max(120).optional(),
      whisper: z.boolean().optional(),
    }),
    z.object({ type: z.literal("ai"), reason: z.string().max(40).optional(), agentId: z.string().min(1).optional() }),
    z.object({
      type: z.literal("ivr"),
      prompt: z.string().min(1).max(500),
      options: z.record(z.string().regex(/^[0-9#*]$/), z.array(stepSchema).min(1)),
      repeats: z.number().int().min(0).max(3).optional(),
    }),
    z.object({ type: z.literal("voicemail"), greeting: z.string().max(500).optional() }),
    z.object({ type: z.literal("reject") }),
    z.object({
      type: z.literal("forward_raw"),
      number: e164,
      timeoutSeconds: z.number().int().min(5).max(120).optional(),
      whisper: z.boolean().optional(),
    }),
  ]),
);

export const ruleSchema: z.ZodType<Rule> = z.object({
  when: z.object({
    schedule: z.enum(scheduleStates).optional(),
    caller: z.enum(callerTags).optional(),
    ivr: z.string().optional(),
  }),
  then: z.array(stepSchema).min(1),
});

/** `simple` is what the editor writes; the rest are earlier templates still found on saved policies. */
export const TEMPLATE_NAMES = ["simple", "you_first", "ai_reception", "office_hours", "front_desk", "custom"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export const periodRouteSchema: z.ZodType<PeriodRoute> = z
  .object({
    mode: z.enum(ANSWER_MODES),
    forwardTo: e164.optional(),
    agentId: z.string().min(1).optional(),
    ringSeconds: z.number().int().min(5).max(120),
  })
  .superRefine((r, ctx) => {
    if (r.mode !== "ai" && !r.forwardTo) ctx.addIssue({ code: "custom", message: "A number to forward to is required." });
    if (r.mode !== "forward" && !r.agentId) ctx.addIssue({ code: "custom", message: "An AI agent is required." });
  });

export const policySchema: z.ZodType<Policy> = z.object({
  version: z.literal(1),
  template: z.enum(TEMPLATE_NAMES).optional(),
  aiAgentId: z.string().min(1).optional(),
  settings: z.object({ inHours: periodRouteSchema, outOfHours: periodRouteSchema }).optional(),
  record: z.boolean().optional(),
  announceRecording: z.boolean().optional(),
  rules: z.array(ruleSchema).min(1),
});

export function parsePolicy(raw: unknown): Policy {
  return policySchema.parse(raw);
}

export const TEMPLATE_LABELS: Record<TemplateName, { title: string }> = {
  simple: { title: "Office hours and outside hours" },
  you_first: { title: "You first, AI backup" },
  ai_reception: { title: "AI reception" },
  office_hours: { title: "Office hours only" },
  front_desk: { title: "Front desk menu" },
  custom: { title: "Custom" },
};

export const ANSWER_LABELS: Record<AnswerMode, { title: string; blurb: string }> = {
  forward: { title: "Forward to a number", blurb: "Calls go straight to the number you enter." },
  ai: { title: "AI agent answers", blurb: "The AI agent you choose answers every call." },
  forward_then_ai: {
    title: "Forward, then AI",
    blurb: "The number you enter rings first. If nobody presses 1 to take the call in time, the AI agent answers.",
  },
};

const blocked: Rule = { when: { caller: "blocked" }, then: [{ type: "reject" }] };

function periodSteps(r: PeriodRoute): Step[] {
  const vm: Step = { type: "voicemail" };
  const ai: Step = { type: "ai", agentId: r.agentId };
  switch (r.mode) {
    case "forward":
      // No press-1: whoever or whatever answers that phone takes the call, its
      // own voicemail included. Ours only catches a phone that never answers.
      return [{ type: "forward_raw", number: r.forwardTo!, timeoutSeconds: r.ringSeconds, whisper: false }, vm];
    case "ai":
      return [ai, vm];
    case "forward_then_ai":
      // Press-1 is what lets the AI take over: without it a mobile's own
      // voicemail would answer and the AI would never be reached.
      return [{ type: "forward_raw", number: r.forwardTo!, timeoutSeconds: r.ringSeconds, whisper: true }, ai, vm];
  }
}

/**
 * The policy the routing editor saves. Closed days and bank holidays count as
 * outside office hours. Voicemail ends every route as the safety net for a
 * phone that never answers or an AI that cannot be reached.
 */
export function simplePolicy(settings: RouteSettings, opts: { record: boolean; announceRecording: boolean }): Policy {
  return {
    version: 1,
    template: "simple",
    settings,
    record: opts.record,
    announceRecording: opts.announceRecording,
    rules: [blocked, { when: { schedule: "in_hours" }, then: periodSteps(settings.inHours) }, { when: {}, then: periodSteps(settings.outOfHours) }],
  };
}

/** Agent id → display name, for the routing pages. */
export type AgentNames = Record<string, string>;

function agentLabel(id: string | undefined, names: AgentNames) {
  return id && names[id] ? `the AI agent (${names[id]})` : "the AI agent";
}

function describeStep(s: Step, names: AgentNames): string {
  switch (s.type) {
    case "ring_humans":
      return `ring your phones for ${s.timeoutSeconds ?? 20}s`;
    case "ai":
      return `${agentLabel(s.agentId, names)} answers`;
    case "ivr":
      return `keypad menu (${Object.keys(s.options).join(", ")})`;
    case "voicemail":
      return "voicemail";
    case "reject":
      return "reject the call";
    case "forward_raw":
      return s.whisper ? `ring ${s.number} for ${s.timeoutSeconds ?? 30}s (press 1 to take it)` : `forward to ${s.number}`;
  }
}

function describePeriod(r: PeriodRoute, names: AgentNames): string {
  switch (r.mode) {
    case "forward":
      return `forward to ${r.forwardTo}.`;
    case "ai":
      return `${agentLabel(r.agentId, names)} answers.`;
    case "forward_then_ai":
      return `ring ${r.forwardTo} for ${r.ringSeconds}s, then ${agentLabel(r.agentId, names)} answers.`;
  }
}

function describeWhen(w: Rule["when"]): string {
  const parts: string[] = [];
  if (w.caller) parts.push({ vip: "VIP callers", blocked: "blocked callers", known: "known callers", unknown: "unknown callers" }[w.caller]);
  if (w.schedule) parts.push({ in_hours: "in hours", out_of_hours: "out of hours", closed_day: "on closed days" }[w.schedule]);
  if (w.ivr) parts.push(`after pressing ${w.ivr}`);
  return parts.length ? parts.join(", ") : "otherwise";
}

/** Plain-English summary of a policy for the routing pages. */
export function describePolicy(policy: Policy, names: AgentNames = {}): string[] {
  const lines = policy.settings
    ? [`Office hours: ${describePeriod(policy.settings.inHours, names)}`, `Outside office hours: ${describePeriod(policy.settings.outOfHours, names)}`]
    : policy.rules.map((r) => `${capitalise(describeWhen(r.when))}: ${r.then.map((s) => describeStep(s, names)).join(" → ")}.`);
  if (policy.record) lines.push(policy.announceRecording ? "Calls are recorded, and callers are told." : "Calls are recorded.");
  return lines;
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Does some `ai` step have no agent to hand the call to? Those steps are skipped on a live call. */
export function policyMissingAgent(policy: Policy): boolean {
  const walk = (steps: Step[]): boolean =>
    steps.some((s) => (s.type === "ai" && !s.agentId && !policy.aiAgentId) || (s.type === "ivr" && Object.values(s.options).some(walk)));
  return policy.rules.some((r) => walk(r.then));
}

/** Every Retell agent id the policy hands calls to. */
export function policyAgentIds(policy: Policy): string[] {
  const ids = new Set<string>();
  if (policy.aiAgentId) ids.add(policy.aiAgentId);
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      if (s.type === "ai" && s.agentId) ids.add(s.agentId);
      if (s.type === "ivr") Object.values(s.options).forEach(walk);
    }
  };
  policy.rules.forEach((r) => walk(r.then));
  return [...ids];
}

/**
 * A phone number as typed ("07979 579352", "+44 (0)7979 579352", "0044…") to
 * E.164, or null. A leading 0 is read as a UK number.
 */
export function toE164(raw: string): string | null {
  let d = raw.trim().replace(/\(0\)/g, "").replace(/[\s().-]/g, "");
  if (d.startsWith("00")) d = `+${d.slice(2)}`;
  else if (d.startsWith("0")) d = `+44${d.slice(1)}`;
  if (d.startsWith("+440")) d = `+44${d.slice(4)}`;
  return /^\+[1-9]\d{6,14}$/.test(d) ? d : null;
}
