import { eq } from "drizzle-orm";
import twilio from "twilio";
import { db } from "@/db/client";
import { twilioAccounts } from "@/db/schema";
import { decryptCredential, encryptCredential } from "@/lib/crypto/credentials";
import { subaccountClient, subaccountCreds } from "@/lib/twilio/master";
import { baseUrl } from "./twiml";

/**
 * Browser softphone (Twilio Voice JS SDK). Each user registers as
 * `user:<profileId>`, which is what a `client` human target dials. The API key
 * and TwiML App live in the client's subaccount and are created on first use.
 */
export async function softphoneCredentials(clientId: string) {
  const creds = await subaccountCreds(clientId);
  if (!creds) throw new Error("This business has no phone account yet. Buy a number first.");
  const row = await db.query.twilioAccounts.findFirst({ where: eq(twilioAccounts.clientId, clientId) });
  if (!row) throw new Error("Twilio account row missing.");

  let keySid = row.apiKeySid;
  let secret = row.apiKeySecretEnc ? decryptCredential(row.apiKeySecretEnc) : null;
  let appSid = row.twimlAppSid;

  if (!keySid || !secret || !appSid) {
    const tw = await subaccountClient(clientId);
    if (!keySid || !secret) {
      const key = await tw.newKeys.create({ friendlyName: "softphone" });
      keySid = key.sid;
      secret = key.secret;
    }
    if (!appSid) {
      const app = await tw.applications.create({
        friendlyName: "softphone",
        voiceUrl: `${baseUrl()}/api/voice/inbound`,
        voiceMethod: "POST",
      });
      appSid = app.sid;
    }
    await db
      .update(twilioAccounts)
      .set({ apiKeySid: keySid, apiKeySecretEnc: encryptCredential(secret), twimlAppSid: appSid })
      .where(eq(twilioAccounts.clientId, clientId));
  }
  return { accountSid: creds.accountSid, keySid, secret, appSid };
}

export function mintSoftphoneToken(opts: { accountSid: string; keySid: string; secret: string; appSid: string; identity: string }) {
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(opts.accountSid, opts.keySid, opts.secret, { identity: opts.identity, ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: opts.appSid, incomingAllow: true }));
  return token.toJwt();
}

export function softphoneIdentity(profileId: string) {
  return `user:${profileId}`;
}
