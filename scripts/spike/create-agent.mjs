// Spike: create a throwaway Retell agent whose transfer destination is the
// {{transfer_number}} dynamic variable that /api/voice/after-dial passes at hand-off.
// Production agents are built in Signal's wizard; this exists only to prove the flow.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { readFileSync, writeFileSync } from "node:fs";

const H = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };
const api = async (path, body) => {
  const r = await fetch("https://api.retellai.com" + path, { method: body ? "POST" : "GET", headers: H, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
};

// Borrow the en-GB voice from the Leonardo demo line so it sounds right.
const demo = await api("/get-agent/agent_c81031b557a8f67ee8459a7003");
const voiceId = demo.voice_id;

const llm = await api("/create-retell-llm", {
  model: "gpt-4.1",
  general_prompt: `You are the AI receptionist for {{business_name}}. The owner could not answer the phone, so you are taking the call (reason: {{reason}}). The caller's number is {{caller_number}}.
Be brief, warm and British. Greet the caller, ask how you can help, and take their name and reason for calling.
If the caller asks to speak to a person, asks for the owner, or says it is urgent, use the transfer_call tool straight away; say "One moment, I'll try to put you through" first.
If the transfer does not connect, apologise, take a message (name, number, reason) and say someone will call back.
When the caller is done, thank them and use end_call.`,
  begin_message: "Hello, thanks for calling {{business_name}}. I'm the AI receptionist, the team can't get to the phone right now. How can I help?",
  general_tools: [
    {
      type: "transfer_call",
      name: "transfer_call",
      description: "Transfer the caller to a human at the business.",
      transfer_destination: { type: "predefined", number: "{{transfer_number}}" },
      transfer_option: { type: "warm_transfer", show_transferee_as_caller: true, private_handoff_option: { type: "prompt", prompt: "Say: I have a caller on the line for you, {{caller_number}}. Connecting now." } },
    },
    { type: "end_call", name: "end_call", description: "End the call when the conversation is finished." },
  ],
});

const agent = await api("/create-agent", {
  agent_name: "ZZ Spike — telephone buying (delete me)",
  response_engine: { type: "retell-llm", llm_id: llm.llm_id },
  voice_id: voiceId,
  language: "en-GB",
  responsiveness: 1,
  interruption_sensitivity: 1,
  enable_backchannel: true,
  end_call_after_silence_ms: 20000,
  max_call_duration_ms: 600000,
});

console.log("llm:", llm.llm_id, "| agent:", agent.agent_id, "| voice:", voiceId);

const path = ".env.local";
const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).filter((l) => !l.startsWith("SPIKE_RETELL_AGENT_ID=") && !l.startsWith("SPIKE_RETELL_LLM_ID="));
lines.push(`SPIKE_RETELL_AGENT_ID=${agent.agent_id}`, `SPIKE_RETELL_LLM_ID=${llm.llm_id}`);
writeFileSync(path, lines.join("\n") + "\n");
console.log("wrote SPIKE_RETELL_AGENT_ID to .env.local");
