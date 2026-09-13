import { z } from "zod";

/**
 * Routing policy: the JSON evaluated on every inbound call to a number.
 *
 *   { version: 1, template, aiAgentId?, rules: [ { when, then: Step[] } ] }
 *
 * Rules are checked in order; the first whose `when` conditions ALL hold wins
 * (an empty `when` always matches, so put it last as the default). The winning
 * rule's steps run in order: a step that ends without a human/AI conversation
 * (no answer, busy, SIP failure, invalid IVR choice) falls through to the next.
 *
 * `aiAgentId` is the Retell agent used by every `ai` step. It is set from the
 * routing editor for now; the Signal partner integration will populate it.
 */

export const scheduleStates = ["in_hours", "out_of_hours", "closed_day"] as const;
export type ScheduleState = (typeof scheduleStates)[number];
export const callerTags = ["vip", "blocked", "known", "unknown"] as const;
export type CallerTag = (typeof callerTags)[number];

export type Step =
  | { type: "ring_humans"; targets?: string[] | "all"; timeoutSeconds?: number; whisper?: boolean }
  | { type: "ai"; reason?: string }
  | { type: "ivr"; prompt: string; options: Record<string, Step[]>; repeats?: number }
  | { type: "voicemail"; greeting?: string }
  | { type: "reject" }
  | { type: "forward_raw"; number: string };

export type Rule = {
  when: { schedule?: ScheduleState; caller?: CallerTag; ivr?: string };
  then: Step[];
};

export type Policy = {
  version: 1;
  template?: TemplateName;
  aiAgentId?: string;
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
    z.object({ type: z.literal("ai"), reason: z.string().max(40).optional() }),
    z.object({
      type: z.literal("ivr"),
      prompt: z.string().min(1).max(500),
      options: z.record(z.string().regex(/^[0-9#*]$/), z.array(stepSchema).min(1)),
      repeats: z.number().int().min(0).max(3).optional(),
    }),
    z.object({ type: z.literal("voicemail"), greeting: z.string().max(500).optional() }),
    z.object({ type: z.literal("reject") }),
    z.object({ type: z.literal("forward_raw"), number: e164 }),
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

export const TEMPLATE_NAMES = ["you_first", "ai_reception", "office_hours", "front_desk", "custom"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export const policySchema: z.ZodType<Policy> = z.object({
  version: z.literal(1),
  template: z.enum(TEMPLATE_NAMES).optional(),
  aiAgentId: z.string().min(1).optional(),
  rules: z.array(ruleSchema).min(1),
});

export function parsePolicy(raw: unknown): Policy {
  return policySchema.parse(raw);
}

export const TEMPLATE_LABELS: Record<TemplateName, { title: string; blurb: string }> = {
  you_first: {
    title: "You first, AI backup",
    blurb: "In hours your phones ring first; if nobody accepts, the AI receptionist takes the call. Out of hours the AI answers straight away.",
  },
  ai_reception: {
    title: "AI reception",
    blurb: "The AI receptionist answers every call and puts callers through to you when they ask for a person.",
  },
  office_hours: {
    title: "Office hours only",
    blurb: "In hours your phones ring, then voicemail. Out of hours the AI receptionist answers.",
  },
  front_desk: {
    title: "Front desk menu",
    blurb: "Callers choose from a keypad menu (for example 1 for sales, 2 for support) and each option has its own route.",
  },
  custom: { title: "Custom", blurb: "Hand-written rules." },
};

export type IvrChoice = "humans" | "ai" | "voicemail";

export type TemplateOptions = {
  ringSeconds?: number;
  aiAgentId?: string;
  ivr?: { prompt: string; options: Record<string, { label: string; to: IvrChoice }> };
};

const blocked: Rule = { when: { caller: "blocked" }, then: [{ type: "reject" }] };

/** Build a policy from one of the shipped templates. */
export function templatePolicy(name: TemplateName, opts: TemplateOptions = {}): Policy {
  const ring: Step = { type: "ring_humans", targets: "all", timeoutSeconds: opts.ringSeconds ?? 20, whisper: true };
  const ringVip: Step = { ...ring, timeoutSeconds: (opts.ringSeconds ?? 20) + 10 };
  const ai: Step = { type: "ai" };
  const vm: Step = { type: "voicemail" };
  const base = { version: 1 as const, template: name, ...(opts.aiAgentId ? { aiAgentId: opts.aiAgentId } : {}) };

  switch (name) {
    case "you_first":
      return {
        ...base,
        rules: [
          blocked,
          { when: { caller: "vip" }, then: [ringVip, ai, vm] },
          { when: { schedule: "in_hours" }, then: [ring, ai, vm] },
          { when: {}, then: [ai, vm] },
        ],
      };
    case "ai_reception":
      return {
        ...base,
        rules: [blocked, { when: { caller: "vip" }, then: [ringVip, ai, vm] }, { when: {}, then: [ai, vm] }],
      };
    case "office_hours":
      return {
        ...base,
        rules: [
          blocked,
          { when: { schedule: "in_hours" }, then: [ring, vm] },
          { when: {}, then: [ai, vm] },
        ],
      };
    case "front_desk": {
      const ivr = opts.ivr ?? {
        prompt: "Thanks for calling. Press 1 to speak to the team, or 2 for the AI receptionist.",
        options: { "1": { label: "Team", to: "humans" }, "2": { label: "AI receptionist", to: "ai" } },
      };
      const branch = (to: IvrChoice): Step[] =>
        to === "humans" ? [ring, ai, vm] : to === "ai" ? [ai, vm] : [vm];
      const options: Record<string, Step[]> = {};
      for (const [digit, o] of Object.entries(ivr.options)) options[digit] = branch(o.to);
      return {
        ...base,
        rules: [
          blocked,
          { when: { schedule: "in_hours" }, then: [{ type: "ivr", prompt: ivr.prompt, options, repeats: 2 }, ai, vm] },
          { when: {}, then: [ai, vm] },
        ],
      };
    }
    case "custom":
      return { ...base, rules: [blocked, { when: {}, then: [ring, ai, vm] }] };
  }
}

function describeStep(s: Step): string {
  switch (s.type) {
    case "ring_humans":
      return `ring your phones for ${s.timeoutSeconds ?? 20}s`;
    case "ai":
      return "the AI receptionist answers";
    case "ivr":
      return `keypad menu (${Object.keys(s.options).join(", ")})`;
    case "voicemail":
      return "voicemail";
    case "reject":
      return "reject the call";
    case "forward_raw":
      return `forward to ${s.number}`;
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
export function describePolicy(policy: Policy): string[] {
  return policy.rules.map((r) => `${capitalise(describeWhen(r.when))}: ${r.then.map(describeStep).join(" → ")}.`);
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Does any step in the policy hand the call to the AI? */
export function policyUsesAi(policy: Policy): boolean {
  const walk = (steps: Step[]): boolean =>
    steps.some((s) => s.type === "ai" || (s.type === "ivr" && Object.values(s.options).some(walk)));
  return policy.rules.some((r) => walk(r.then));
}
