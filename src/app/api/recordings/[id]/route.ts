import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { callRecordings, voicemails } from "@/db/schema";
import { currentClient } from "@/lib/clients";
import { fetchRecording } from "@/lib/routing/recordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PASS_HEADERS = ["content-length", "content-range", "accept-ranges"];

/**
 * Play a call recording or a voicemail of the business the viewer has
 * selected; anyone who can see its Calls page can listen. The audio is
 * proxied because Twilio's recording URLs need the subaccount's credentials.
 * Range requests pass through so the player can seek.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const { client } = await currentClient();
  if (!client) return new Response("Not found", { status: 404 });
  const rec =
    (await db.query.callRecordings.findFirst({ where: and(eq(callRecordings.id, id), eq(callRecordings.clientId, client.id)) })) ??
    (await db.query.voicemails.findFirst({ where: and(eq(voicemails.id, id), eq(voicemails.clientId, client.id)) }));
  if (!rec) return new Response("Not found", { status: 404 });

  const res = await fetchRecording(client.id, rec.recordingUrl, req.headers.get("range"));
  if (!res.ok || !res.body) return new Response("Recording unavailable", { status: 502 });
  const headers = new Headers({ "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" });
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
