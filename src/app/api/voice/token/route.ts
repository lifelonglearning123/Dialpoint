import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { numbers } from "@/db/schema";
import { currentClient } from "@/lib/clients";
import { mintSoftphoneToken, softphoneCredentials, softphoneIdentity } from "@/lib/routing/softphone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Voice SDK token for the signed-in user's browser softphone (identity user:<profileId>). */
export async function GET() {
  const { session, client } = await currentClient();
  if (!client) return NextResponse.json({ error: "No business selected." }, { status: 400 });
  try {
    const creds = await softphoneCredentials(client.id);
    const identity = softphoneIdentity(session.profileId);
    const own = await db.query.numbers.findMany({
      where: and(eq(numbers.clientId, client.id), eq(numbers.status, "active")),
      columns: { e164: true },
    });
    return NextResponse.json({ identity, token: mintSoftphoneToken({ ...creds, identity }), callerId: own[0]?.e164 ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
