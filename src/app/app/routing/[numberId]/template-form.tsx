"use client";

import { useState } from "react";

type Template = { value: string; title: string; blurb: string };
type IvrTo = "humans" | "ai" | "voicemail";

export function TemplateForm(props: {
  templates: Template[];
  initialTemplate: string;
  initialRingSeconds: number;
  initialAgentId: string;
  initialIvr: { prompt: string; options: Record<string, IvrTo> } | null;
}) {
  const [template, setTemplate] = useState(props.initialTemplate);
  const usesHumans = template !== "ai_reception";
  const usesAi = true;

  return (
    <div className="space-y-6">
      <fieldset className="card space-y-3">
        <legend className="sr-only">Template</legend>
        <h2 className="font-semibold">How should this number be answered?</h2>
        {props.templates.map((t) => (
          <label key={t.value} className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${template === t.value ? "border-slate-900 bg-slate-50" : "border-slate-200"}`}>
            <input type="radio" name="template" value={t.value} checked={template === t.value} onChange={() => setTemplate(t.value)} className="mt-1" />
            <span>
              <span className="block font-medium">{t.title}</span>
              <span className="block text-sm text-slate-500">{t.blurb}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {usesHumans && (
        <div className="card space-y-2">
          <label className="block text-sm">
            <span className="font-medium">Ring your phones for</span>
            <div className="mt-1 flex items-center gap-2">
              <input type="number" name="ringSeconds" min={5} max={120} defaultValue={props.initialRingSeconds} className="input w-24" />
              <span className="text-slate-500">seconds before moving on</span>
            </div>
          </label>
          <p className="text-xs text-slate-500">Which phones ring is set on the Routing page under &ldquo;Who answers&rdquo;.</p>
        </div>
      )}

      {template === "front_desk" && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Keypad menu</h2>
          <label className="block text-sm">
            <span className="font-medium">What the caller hears</span>
            <textarea
              name="ivrPrompt"
              rows={2}
              defaultValue={props.initialIvr?.prompt ?? "Thanks for calling. Press 1 to speak to the team, or 2 for the AI receptionist."}
              className="input mt-1"
            />
          </label>
          {["1", "2", "3", "4"].map((d) => (
            <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-16 font-medium">Press {d}</span>
              <input name={`ivr_${d}_label`} placeholder="Label (optional)" defaultValue={props.initialIvr ? labelFor(props.initialIvr.options[d]) : d === "1" ? "Team" : d === "2" ? "AI receptionist" : ""} className="input w-48" />
              <select name={`ivr_${d}_to`} defaultValue={props.initialIvr?.options[d] ?? (d === "1" ? "humans" : d === "2" ? "ai" : "")} className="input w-56">
                <option value="">Not used</option>
                <option value="humans">Ring your phones, then AI</option>
                <option value="ai">AI receptionist</option>
                <option value="voicemail">Voicemail</option>
              </select>
            </div>
          ))}
        </div>
      )}

      {usesAi && (
        <div className="card space-y-2">
          <label className="block text-sm">
            <span className="font-medium">AI receptionist</span>
            <input name="aiAgentId" defaultValue={props.initialAgentId} placeholder="agent_… (from your AI receptionist dashboard)" className="input mt-1" />
          </label>
          <p className="text-xs text-slate-500">
            Temporary: paste the agent id from your AI receptionist dashboard. Soon this becomes a one-click &ldquo;Add AI receptionist&rdquo; hop. Leave blank and AI steps are skipped.
          </p>
        </div>
      )}
    </div>
  );
}

function labelFor(to: IvrTo | undefined) {
  return to === "humans" ? "Team" : to === "ai" ? "AI receptionist" : to === "voicemail" ? "Voicemail" : "";
}
