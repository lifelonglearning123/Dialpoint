import { NextResponse } from "next/server";
import { twiml as TwiML } from "twilio";
import { spike } from "./config";

export const VoiceResponse = TwiML.VoiceResponse;

export function xml(doc: InstanceType<typeof VoiceResponse>) {
  return new NextResponse(doc.toString(), { headers: { "Content-Type": "text/xml" } });
}

export function url(path: string, params: Record<string, string> = {}) {
  const u = new URL(spike.baseUrl() + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * ring_humans step: ring the PSTN target (with press-1 whisper) and the browser
 * softphone at the same time. answerOnBridge keeps the caller in ringback until a
 * human actually accepts, so the whisper is never heard by the caller and the
 * parent call is not "answered" (and billed) until then.
 */
export function ringHumans(opts: {
  businessName: string;
  humanNumber: string;
  clientIdentity: string;
  ringSeconds: number;
  callerId: string;
  /** "transfer" = the AI is handing the caller over; changes the whisper and the action route. */
  why?: "transfer";
}) {
  const r = new VoiceResponse();
  const dial = r.dial({
    timeout: opts.ringSeconds,
    answerOnBridge: true,
    callerId: opts.callerId,
    action: url(opts.why === "transfer" ? "/api/voice/after-transfer" : "/api/voice/after-dial", { step: "ring_humans" }),
    method: "POST",
  });
  if (opts.humanNumber) dial.number(
    {
      url: url("/api/voice/whisper", { biz: opts.businessName, ...(opts.why ? { why: opts.why } : {}) }),
      method: "POST",
      statusCallback: url("/api/voice/status", { leg: "human_pstn" }),
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    },
    opts.humanNumber,
  );
  dial.client(
    {
      statusCallback: url("/api/voice/status", { leg: "human_client" }),
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    },
    opts.clientIdentity,
  );
  return r;
}

/** Whisper played to the human leg only. No keypress -> hang up that leg only. */
export function whisper(businessName: string, why?: string) {
  const r = new VoiceResponse();
  const g = r.gather({ numDigits: 1, timeout: 5, action: url("/api/voice/whisper-accept"), method: "POST" });
  g.say(
    { language: "en-GB" },
    why === "transfer"
      ? `The AI receptionist for ${businessName} is transferring a caller to you. Press 1 to accept.`
      : `Call for ${businessName}. Press 1 to accept.`,
  );
  r.say({ language: "en-GB" }, "No answer. Goodbye.");
  r.hangup();
  return r;
}

export function whisperAccept(digits: string | undefined) {
  const r = new VoiceResponse();
  if (digits === "1") return r; // empty <Response/> = accept, Twilio bridges the legs
  r.hangup();
  return r;
}

/** ai step: hand the live call to Retell over SIP. */
export function dialRetell(callId: string, sipHost: string) {
  const r = new VoiceResponse();
  const dial = r.dial({ action: url("/api/voice/after-ai"), method: "POST", answerOnBridge: true });
  dial.sip(
    {
      statusCallback: url("/api/voice/status", { leg: "ai" }),
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    },
    `sip:${callId}@${sipHost}`,
  );
  return r;
}

/** voicemail step: terminal fallback. */
export function voicemail(businessName: string) {
  const r = new VoiceResponse();
  r.say({ language: "en-GB" }, `Sorry, nobody at ${businessName} can take your call right now. Please leave a message after the tone.`);
  r.record({
    maxLength: 120,
    playBeep: true,
    action: url("/api/voice/after-voicemail"),
    method: "POST",
    recordingStatusCallback: url("/api/voice/status", { leg: "voicemail_recording" }),
    transcribe: false,
  });
  r.say({ language: "en-GB" }, "Thank you. Goodbye.");
  return r;
}

export function hangup() {
  const r = new VoiceResponse();
  r.hangup();
  return r;
}
