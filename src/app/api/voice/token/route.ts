import { NextResponse } from "next/server";
import twilio from "twilio";
import { spike } from "@/lib/spike/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mints a Twilio Voice SDK access token for the spike softphone identity. */
export async function GET() {
  const { sid: keySid, secret } = spike.apiKey();
  const appSid = spike.twimlAppSid();
  if (!keySid || !secret || !appSid) {
    return NextResponse.json({ error: "TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET / TWILIO_TWIML_APP_SID not set" }, { status: 500 });
  }
  // The API key + TwiML app were created on the account that owns the number (master unless SPIKE_USE_SUBACCOUNT=1).
  const accountSid = process.env.SPIKE_USE_SUBACCOUNT === "1" ? spike.subaccountSid()! : spike.twilio().sid;
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(accountSid, keySid, secret, { identity: spike.clientIdentity(), ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true }));
  return NextResponse.json({ identity: spike.clientIdentity(), token: token.toJwt(), testNumber: process.env.SPIKE_NUMBER ?? "" });
}
