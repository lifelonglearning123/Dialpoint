// Replace the spike agent's native transfer_call tool (which cannot dial out on a
// SIP-delivered call) with a custom webhook tool that asks this app to redirect
// the Twilio parent call. Re-run whenever PUBLIC_BASE_URL changes.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const H = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };
const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
const llmId = process.env.SPIKE_RETELL_LLM_ID;

const res = await fetch(`https://api.retellai.com/update-retell-llm/${llmId}`, {
  method: "PATCH",
  headers: H,
  body: JSON.stringify({
    general_prompt: `You are the AI receptionist for {{business_name}}. You are taking the call because: {{reason}} ("overflow" = the owner did not answer; "transfer_failed" = you just tried to transfer this caller to a person and nobody picked up, so apologise and take a message). The caller's number is {{caller_number}}.
Be brief, warm and British. Greet the caller, ask how you can help, and take their name and reason for calling.
If the caller asks to speak to a person, asks for the owner, or says it is urgent, say "One moment, I'll try to put you through" and then call the transfer_to_human tool. Say nothing after calling it; the line will be handed over.
If the tool reports the transfer failed, apologise, take a message (name, number, reason) and say someone will call back.
When the caller is done, thank them and use end_call.`,
    general_tools: [
      {
        type: "custom",
        name: "transfer_to_human",
        description: "Hand the caller over to a person at the business. Use when the caller asks for a human, the owner, or says it is urgent.",
        url: `${base}/api/voice/retell-transfer`,
        speak_during_execution: false,
        speak_after_execution: true,
        timeout_ms: 15000,
        parameters: { type: "object", properties: { reason: { type: "string", description: "Why the caller wants a person" } }, required: [] },
      },
      { type: "end_call", name: "end_call", description: "End the call when the conversation is finished." },
    ],
  }),
});
if (!res.ok) throw new Error(`update llm ${res.status}: ${await res.text()}`);
const llm = await res.json();
console.log("updated", llm.llm_id, "tools:", llm.general_tools.map((t) => `${t.type}:${t.name}`).join(", "), "| url", base);
