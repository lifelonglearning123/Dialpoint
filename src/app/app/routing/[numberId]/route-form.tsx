"use client";

import { useState } from "react";
import { ANSWER_LABELS, ANSWER_MODES, type AnswerMode, type PeriodRoute } from "@/lib/routing/policy";

type Agent = { id: string; name: string };

const PLATFORM_NAMES: Record<string, string> = { elevenlabs: "ElevenLabs", ghl: "GoHighLevel", retell: "Retell" };

export function RouteForm(props: {
  clientName: string;
  /** "Mon–Fri 09:00–17:30", or null when the business has no hours set. */
  hours: string | null;
  agents: Agent[];
  unsupportedAgents: Array<{ name: string; platform: string }>;
  inHours: PeriodRoute;
  outOfHours: PeriodRoute;
  record: boolean;
  announceRecording: boolean;
}) {
  const [record, setRecord] = useState(props.record);

  return (
    <div className="space-y-6">
      <Period
        prefix="in"
        title="During office hours"
        subtitle={props.hours ? `Office hours: ${props.hours}.` : `${props.clientName} has no office hours set, so this applies to every call.`}
        initial={props.inHours}
        agents={props.agents}
        clientName={props.clientName}
      />
      <Period
        prefix="out"
        title="Outside office hours"
        subtitle={
          props.hours
            ? "Evenings, weekends, bank holidays and closed days."
            : "Not used until office hours are set on the Routing page."
        }
        initial={props.outOfHours}
        agents={props.agents}
        clientName={props.clientName}
      />

      {props.unsupportedAgents.length > 0 && (
        <p className="text-xs text-slate-500">
          Not available here yet:{" "}
          {props.unsupportedAgents.map((a) => `${a.name} (${PLATFORM_NAMES[a.platform] ?? a.platform})`).join(", ")}. Only Retell agents can answer calls
          from this number for now.
        </p>
      )}

      <div className="card space-y-3">
        <h2 className="font-semibold">Call recording</h2>
        <label className="flex gap-3 text-sm">
          <input type="checkbox" name="record" checked={record} onChange={(e) => setRecord(e.target.checked)} className="mt-1" />
          <span>
            <span className="block font-medium">Record every call</span>
            <span className="block text-slate-500">
              Conversations with the forwarded phone or the AI agent are recorded and can be played on the Calls page. Voicemails are always recorded.
            </span>
          </span>
        </label>
        <label className={`flex gap-3 text-sm ${record ? "" : "opacity-50"}`}>
          <input type="checkbox" name="announce" defaultChecked={props.announceRecording} disabled={!record} className="mt-1" />
          <span>
            <span className="block font-medium">Tell callers first</span>
            <span className="block text-slate-500">
              Callers hear &ldquo;This call may be recorded&rdquo; before anything else. UK rules expect callers to be told.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

function Period(props: { prefix: "in" | "out"; title: string; subtitle: string; initial: PeriodRoute; agents: Agent[]; clientName: string }) {
  const noAgents = props.agents.length === 0;
  // With no agent to pick, only plain forwarding can be saved.
  const [mode, setMode] = useState<AnswerMode>(noAgents ? "forward" : props.initial.mode);
  const p = props.prefix;

  return (
    <fieldset className="card space-y-4">
      <legend className="sr-only">{props.title}</legend>
      <div>
        <h2 className="font-semibold">{props.title}</h2>
        <p className="text-sm text-slate-500">{props.subtitle}</p>
      </div>

      <div className="space-y-2">
        {ANSWER_MODES.map((m) => {
          const needsAgent = m !== "forward";
          const disabled = needsAgent && noAgents;
          return (
            <label
              key={m}
              className={`flex gap-3 rounded-lg border p-3 ${mode === m ? "border-slate-900 bg-slate-50" : "border-slate-200"} ${disabled ? "opacity-50" : "cursor-pointer"}`}
            >
              <input type="radio" name={`${p}_mode`} value={m} checked={mode === m} disabled={disabled} onChange={() => setMode(m)} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">{ANSWER_LABELS[m].title}</span>
                <span className="block text-sm text-slate-500">{ANSWER_LABELS[m].blurb}</span>
              </span>
            </label>
          );
        })}
        {noAgents && <p className="text-xs text-amber-700">No AI agents yet. Retell agents built in Signal for this business appear here.</p>}
      </div>

      {mode !== "ai" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Forward to</span>
            <input
              name={`${p}_forwardTo`}
              type="tel"
              required
              defaultValue={props.initial.forwardTo ?? ""}
              placeholder="07700 900123"
              pattern="[+0-9 \(\)\-]{7,20}"
              className="input mt-1"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Ring for</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                key={mode}
                type="number"
                name={`${p}_ringSeconds`}
                min={5}
                max={120}
                defaultValue={props.initial.mode === mode ? props.initial.ringSeconds : mode === "forward" ? 30 : 20}
                className="input w-24"
              />
              <span className="text-slate-500">{mode === "forward" ? "seconds, then voicemail" : "seconds, then the AI"}</span>
            </div>
          </label>
        </div>
      )}
      {mode === "forward" && (
        <p className="text-xs text-slate-500">If that phone has its own voicemail, callers who aren&apos;t answered hear that voicemail.</p>
      )}
      {mode === "forward_then_ai" && (
        <p className="text-xs text-slate-500">
          The person answering hears &ldquo;Call for {props.clientName}. Press 1 to accept.&rdquo; Only pressing 1 connects the caller, so the phone&apos;s own
          voicemail can never take the call from the AI.
        </p>
      )}

      {mode !== "forward" && !noAgents && (
        <label className="block text-sm">
          <span className="font-medium">AI agent</span>
          <select name={`${p}_agentId`} required defaultValue={props.initial.agentId ?? props.agents[0]?.id ?? ""} className="input mt-1">
            {props.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}
