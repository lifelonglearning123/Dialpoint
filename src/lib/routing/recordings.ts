import { callRecordings } from "@/db/schema";
import { db } from "@/db/client";
import { masterCreds, subaccountCreds } from "@/lib/twilio/master";
import { appendTrace } from "./calls";

/** Recording callback for an answered <Dial> on a number with recording on. */
export async function storeCallRecording(input: { callId: string; clientId: string; recordingSid: string; recordingUrl: string; durationSeconds: number | null }) {
  await db.insert(callRecordings).values(input).onConflictDoNothing();
  await appendTrace(input.callId, "call_recorded", { recordingSid: input.recordingSid, duration: String(input.durationSeconds ?? "") });
}

/**
 * Fetch a recording's MP3 from the client's Twilio subaccount. Recording URLs
 * need the account's credentials, so the browser never gets them directly.
 */
export async function fetchRecording(clientId: string, recordingUrl: string, range?: string | null): Promise<Response> {
  const creds = (await subaccountCreds(clientId)) ?? masterCreds();
  return fetch(`${recordingUrl}.mp3`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64"),
      ...(range ? { Range: range } : {}),
    },
  });
}
