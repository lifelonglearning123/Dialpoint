import { eq } from "drizzle-orm";
import OpenAI, { toFile } from "openai";
import { db } from "@/db/client";
import { voicemails } from "@/db/schema";
import { env } from "@/env";
import { recordUsage } from "@/lib/billing/usage";
import { reportCallToSignal } from "@/lib/signal/report";
import { appendTrace } from "./calls";
import { fetchRecording } from "./recordings";

/**
 * Recording finished: store the voicemail, then transcribe and summarise it.
 * Called from the recording status callback; the caller should run the slow
 * part after the response (next/server `after`) so Twilio is not kept waiting.
 */
export async function storeVoicemail(input: { callId: string; clientId: string; recordingSid: string; recordingUrl: string; durationSeconds: number | null }) {
  const [row] = await db
    .insert(voicemails)
    .values({
      callId: input.callId,
      clientId: input.clientId,
      recordingSid: input.recordingSid,
      recordingUrl: input.recordingUrl,
      durationSeconds: input.durationSeconds,
    })
    .onConflictDoNothing()
    .returning();
  await appendTrace(input.callId, "voicemail_recorded", { recordingSid: input.recordingSid, duration: String(input.durationSeconds ?? "") });
  return row ?? (await db.query.voicemails.findFirst({ where: eq(voicemails.recordingSid, input.recordingSid) }))!;
}

async function downloadRecording(clientId: string, recordingUrl: string): Promise<Buffer> {
  const res = await fetchRecording(clientId, recordingUrl);
  if (!res.ok) throw new Error(`recording download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribeVoicemail(voicemailId: string) {
  const vm = await db.query.voicemails.findFirst({ where: eq(voicemails.id, voicemailId) });
  if (!vm || vm.transcript) return;
  if (!env.OPENAI_API_KEY) {
    console.warn("[voicemail] OPENAI_API_KEY not set, skipping transcription");
    return;
  }
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  try {
    const audio = await downloadRecording(vm.clientId, vm.recordingUrl);
    const t = await openai.audio.transcriptions.create({
      file: await toFile(audio, "voicemail.mp3", { type: "audio/mpeg" }),
      model: "gpt-4o-mini-transcribe",
      language: "en",
    });
    const transcript = (t.text ?? "").trim();
    let summary: string | null = null;
    if (transcript) {
      try {
        const r = await openai.chat.completions.create({
          model: process.env.OPENAI_SUMMARY_MODEL ?? "gpt-5.5",
          messages: [
            { role: "system", content: "Summarise this voicemail for a busy business owner in one short sentence: who called, what they want, any number or time mentioned. British English. No preamble." },
            { role: "user", content: transcript },
          ],
        });
        summary = r.choices[0]?.message?.content?.trim() || null;
      } catch (e) {
        console.warn("[voicemail] summary failed", e);
        summary = transcript.length > 140 ? transcript.slice(0, 137) + "…" : transcript;
      }
    }
    await db.update(voicemails).set({ transcript: transcript || "(no speech detected)", summary, transcribedAt: new Date() }).where(eq(voicemails.id, vm.id));
    await appendTrace(vm.callId, "voicemail_transcribed", { chars: String(transcript.length) });
    // Billing (Phase 3): one transcription; only charged when the plan prices it.
    await recordUsage({ clientId: vm.clientId, callId: vm.callId, sourceSid: vm.recordingSid, meter: "voicemail_transcribe", count: 1 }).catch((e) =>
      console.error("[usage] voicemail", e),
    );
  } catch (e) {
    console.error("[voicemail] transcription failed", e);
    await appendTrace(vm.callId, "voicemail_transcription_failed", { error: String(e).slice(0, 200) });
  }
  // Transcribed (or given up): the voicemail can go to Signal's call log now.
  await reportCallToSignal(vm.callId).catch((e) => console.error("[signal] voicemail report", e));
}
