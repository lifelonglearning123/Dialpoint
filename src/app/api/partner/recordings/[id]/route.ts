import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { callRecordings, voicemails } from "@/db/schema";
import { fetchRecording } from "@/lib/routing/recordings";
import { verifyRecordingLink } from "@/lib/signal/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One recording (call or voicemail) for Signal, behind the expiring signed
 * link in its phone-line report (src/lib/signal/report.ts). No session: the
 * signature is the permission, and it names exactly one recording.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !verifyRecordingLink(id, sp.get("exp"), sp.get("sig"))) {
    return new Response("Not found", { status: 404 });
  }
  const rec =
    (await db.query.callRecordings.findFirst({ where: eq(callRecordings.id, id) })) ??
    (await db.query.voicemails.findFirst({ where: eq(voicemails.id, id) }));
  if (!rec) return new Response("Not found", { status: 404 });

  const res = await fetchRecording(rec.clientId, rec.recordingUrl);
  if (!res.ok || !res.body) return new Response("Recording unavailable", { status: 502 });
  const headers = new Headers({ "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store" });
  const length = res.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  return new Response(res.body, { status: 200, headers });
}
