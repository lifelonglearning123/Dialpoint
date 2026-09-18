import { NextResponse } from "next/server";
import { twiml as TwiML } from "twilio";
import { env } from "@/env";

export const VoiceResponse = TwiML.VoiceResponse;
export type Twiml = InstanceType<typeof VoiceResponse>;

export function xml(doc: { toString(): string }) {
  return new NextResponse(doc.toString(), { headers: { "Content-Type": "text/xml" } });
}

/** Public origin for webhook URLs. Lenient (no https check) so local simulations work. */
export function baseUrl(): string {
  return (env.PUBLIC_BASE_URL ?? env.NEXT_PUBLIC_APP_URL).replace(/\/$/, "");
}

export function url(path: string, params: Record<string, string | undefined> = {}) {
  const u = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const SAY = { language: "en-GB" as const };
const STATUS_EVENTS = ["initiated", "ringing", "answered", "completed"] as const;
type Ev = (typeof STATUS_EVENTS)[number];
const EVENTS = STATUS_EVENTS as unknown as Ev[];

export type RingTarget = { kind: "pstn"; number: string } | { kind: "client"; identity: string };

/**
 * <Dial> attributes that record the conversation once someone (a person or
 * the AI) answers, both sides on separate channels. The recording callback
 * carries the cursor so it lands on the right call.
 */
function recording(record: boolean | undefined, cursor: string) {
  if (!record) return {};
  return {
    record: "record-from-answer-dual" as const,
    recordingStatusCallback: url("/api/voice/status", { leg: "call_recording", k: cursor }),
    recordingStatusCallbackEvent: ["completed" as const],
    recordingStatusCallbackMethod: "POST",
  };
}

/** Press-1 whisper on a PSTN leg: the call only bridges once the person accepts. */
function whisperAttrs(businessName: string, cursor: string, transfer?: boolean) {
  return { url: url("/api/voice/whisper", { biz: businessName, why: transfer ? "transfer" : undefined, k: cursor }), method: "POST" };
}

/**
 * ring_humans: every target rings at once. PSTN legs get the press-1 whisper;
 * browser legs bridge on answer. answerOnBridge keeps the caller in ringback
 * until someone actually accepts, so the parent is never "answered" by a
 * voicemail and only DialBridged=true ever means a human took the call.
 */
export function ringHumans(opts: {
  cursor: string;
  businessName: string;
  targets: RingTarget[];
  timeoutSeconds: number;
  callerId: string;
  whisper: boolean;
  transfer?: boolean;
  record?: boolean;
}) {
  const r = new VoiceResponse();
  const dial = r.dial({
    timeout: opts.timeoutSeconds,
    answerOnBridge: true,
    callerId: opts.callerId,
    action: url(opts.transfer ? "/api/voice/after-transfer" : "/api/voice/after-step", { k: opts.cursor }),
    method: "POST",
    ...recording(opts.record, opts.cursor),
  });
  for (const t of opts.targets) {
    if (t.kind === "pstn") {
      dial.number(
        {
          ...(opts.whisper ? whisperAttrs(opts.businessName, opts.cursor, opts.transfer) : {}),
          statusCallback: url("/api/voice/status", { leg: "human_pstn", k: opts.cursor }),
          statusCallbackEvent: EVENTS,
        },
        t.number,
      );
    } else {
      dial.client(
        { statusCallback: url("/api/voice/status", { leg: "human_client", k: opts.cursor }), statusCallbackEvent: EVENTS },
        t.identity,
      );
    }
  }
  return r;
}

/** Whisper played to the human leg only. No keypress → hang up that leg only. */
export function whisper(businessName: string, why?: string, cursor?: string) {
  const r = new VoiceResponse();
  const g = r.gather({ numDigits: 1, timeout: 5, action: url("/api/voice/whisper-accept", { k: cursor }), method: "POST" });
  g.say(
    SAY,
    why === "transfer"
      ? `The AI receptionist for ${businessName} is transferring a caller to you. Press 1 to accept.`
      : `Call for ${businessName}. Press 1 to accept.`,
  );
  r.say(SAY, "No answer. Goodbye.");
  r.hangup();
  return r;
}

export function whisperAccept(digits: string | undefined) {
  const r = new VoiceResponse();
  if (digits === "1") return r; // empty <Response/> accepts: Twilio bridges the legs
  r.hangup();
  return r;
}

/** ai: hand the live call to Retell over SIP. */
export function dialRetell(opts: { cursor: string; sipUri: string; afterPath?: "/api/voice/after-step" | "/api/voice/after-ai"; record?: boolean }) {
  const r = new VoiceResponse();
  const dial = r.dial({
    action: url(opts.afterPath ?? "/api/voice/after-step", { k: opts.cursor }),
    method: "POST",
    answerOnBridge: true,
    ...recording(opts.record, opts.cursor),
  });
  dial.sip({ statusCallback: url("/api/voice/status", { leg: "ai", k: opts.cursor }), statusCallbackEvent: EVENTS }, opts.sipUri);
  return r;
}

export function ivr(opts: { cursor: string; prompt: string; digits: string[] }) {
  const r = new VoiceResponse();
  const g = r.gather({
    numDigits: 1,
    timeout: 6,
    action: url("/api/voice/after-step", { k: opts.cursor }),
    method: "POST",
    input: ["dtmf"],
  });
  g.say(SAY, opts.prompt);
  // No input: Gather falls through, so re-post to the same step for a retry.
  r.redirect({ method: "POST" }, url("/api/voice/after-step", { k: opts.cursor, timeout: "1" }));
  return r;
}

export function voicemail(opts: { cursor: string; businessName: string; greeting?: string }) {
  const r = new VoiceResponse();
  r.say(SAY, opts.greeting ?? `Sorry, nobody at ${opts.businessName} can take your call right now. Please leave a message after the tone.`);
  r.record({
    maxLength: 180,
    playBeep: true,
    action: url("/api/voice/after-voicemail", { k: opts.cursor }),
    method: "POST",
    recordingStatusCallback: url("/api/voice/status", { leg: "voicemail_recording", k: opts.cursor }),
    recordingStatusCallbackEvent: ["completed"],
    transcribe: false,
  });
  r.say(SAY, "Thank you. Goodbye.");
  return r;
}

export function reject() {
  const r = new VoiceResponse();
  r.reject({ reason: "rejected" });
  return r;
}

/**
 * forward_raw: one outside number. With `whisper` the person must press 1, so
 * an unanswered phone (or its own voicemail) falls through to the next step;
 * without it, whatever answers that phone takes the call.
 */
export function forwardRaw(opts: {
  cursor: string;
  number: string;
  callerId: string;
  timeoutSeconds?: number;
  whisper?: boolean;
  businessName: string;
  record?: boolean;
}) {
  const r = new VoiceResponse();
  const dial = r.dial({
    timeout: opts.timeoutSeconds ?? 30,
    answerOnBridge: true,
    callerId: opts.callerId,
    action: url("/api/voice/after-step", { k: opts.cursor }),
    method: "POST",
    ...recording(opts.record, opts.cursor),
  });
  dial.number(
    {
      ...(opts.whisper ? whisperAttrs(opts.businessName, opts.cursor) : {}),
      statusCallback: url("/api/voice/status", { leg: "human_pstn", k: opts.cursor }),
      statusCallbackEvent: EVENTS,
    },
    opts.number,
  );
  return r;
}

/** A finished response with one spoken line put in front of it (the recording notice). */
export function withNotice(doc: Twiml, notice: string): { toString(): string } {
  const lead = new VoiceResponse();
  lead.say(SAY, notice);
  const body = doc.toString().replace(/^<\?xml[^>]*\?>/, "").replace(/^<Response\/>$/, "").replace(/^<Response>|<\/Response>$/g, "");
  const merged = lead.toString().replace(/<\/Response>$/, `${body}</Response>`);
  return { toString: () => merged };
}

export function hangup(sayFirst?: string) {
  const r = new VoiceResponse();
  if (sayFirst) r.say(SAY, sayFirst);
  r.hangup();
  return r;
}
