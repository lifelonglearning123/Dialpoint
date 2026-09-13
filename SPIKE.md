# Phase 0 spike — runbook

Proves, on one real UK number: press-1 forward to a mobile → no-answer overflow into a Signal (Retell) agent over SIP → agent transfers back to the mobile → voicemail fallback; plus the browser softphone ringing alongside the mobile.

Status 2026-09-13 21:25: live on +44 20 4652 7858 (master account, bundle + address attached). PROVEN: press-1 forward with caller ID (bridged 9s), voicemail-answered leg correctly overflows (DialBridged=false), AI hand-off via Retell register + <Dial><Sip> connects in ~1s, dynamic vars arrive at the agent. Softphone proven as caller (browser → test line → mobile pressed 1 → bridged) and it rings alongside the mobile. AI→human transfer PROVEN both ways (21:51 accepted and bridged; 21:52 not accepted → AI re-registered with reason transfer_failed and took over). Not exercised live: softphone answering, voicemail (both verified with simulated posts only).

**Spike verdict: GO.** Every open question answered, see "What the spike must answer" below.

Lessons for production: (1) only `DialBridged=true` means a human accepted; `DialCallStatus=completed` also fires when a voicemail answered and the whisper timed out. (2) Never forward to the caller's own number. (3) UK geographic numbers need an `AddressSid` (validated address) as well as the regulatory bundle (Twilio error 21631).

## 1. Fill `.env.local`

```
TWILIO_ACCOUNT_SID=AC...          # master account (Twilio console → Account info)
TWILIO_AUTH_TOKEN=...
RETELL_API_KEY=key_...            # from Retell dashboard (Signal's key)
SPIKE_RETELL_AGENT_ID=agent_...   # run: node scripts/spike/inspect.mjs   (lists agents)
SPIKE_HUMAN_NUMBER=+447...        # the mobile that should ring
```

## 2. Inspect (read-only)

```
node scripts/spike/inspect.mjs
```
Shows subaccounts, UK numbers already owned, approved regulatory bundles, whether 03 numbers exist in inventory, and the Retell agents. Decide from the bundle list whether the test number can be bought in the master account (needs an approved GB local bundle there) or must go in a subaccount with its own bundle.

## 3. Tunnel + dev server (two terminals)

```
npm run spike:tunnel        # prints https://xxxx.trycloudflare.com
npm run dev                 # port 3410
```
Put the tunnel URL in `.env.local` as `PUBLIC_BASE_URL=https://xxxx.trycloudflare.com` and restart `npm run dev`. The quick-tunnel URL changes every run; re-run `node scripts/spike/provision.mjs point` after each change.

## 4. Provision

```
node scripts/spike/provision.mjs subaccount            # optional: creates "spike:telephone-buying" subaccount
node scripts/spike/provision.mjs search 4420*          # London locals (or 4416* etc.)
node scripts/spike/provision.mjs buy +4420XXXXXXXX     # £3.50/mo, points webhook at PUBLIC_BASE_URL
node scripts/spike/provision.mjs apikey                # API key + TwiML app for the softphone
```

## 5. Test calls

1. Open `http://localhost:3410/softphone` (registers as `spike-softphone`).
2. Ring the test number from another phone. Mobile and softphone ring together. Mobile hears "Call for Spike Test Line, press 1 to accept".
3. Press 1 → bridged. Hang up. Trace shows `human_accepted`.
4. Ring again, ignore it for 20s → AI answers. Ask it to transfer you → mobile rings from the AI. Trace shows `after_ring_humans` (no-answer) → `ai_registered` → `after_ai`.
5. Stop the dev server mid-call flow to see the voicemail fallback (`ai_register_failed` → `<Record>`).
6. `curl http://localhost:3410/api/voice/trace` for the full route trace; note webhook latency in the dev log.

## 6. Tear down

```
node scripts/spike/provision.mjs release               # stops the monthly charge
```
Suspend or close the spike subaccount in the Twilio console if one was created.

## What the spike must answer (answered 2026-09-13)

- **Retell's native transfer does NOT work** on a call that arrived via `<Dial><Sip>`: tool result "The number to transfer from is not valid" (Retell cannot dial out from a number it does not own). **The fallback works and is the production design**: the agent has a custom tool → `POST /api/voice/retell-transfer` → Twilio REST `calls(parentSid).update({twiml})` redirects the parent call to `ring_humans` with a transfer whisper; `/api/voice/after-transfer` re-registers the AI (reason `transfer_failed`) if nobody accepts. Redirect takes ~3s including a 2.5s pause so the agent can finish "one moment". Note: after a REST redirect Twilio still fires the old `<Dial>` action (`after_ai`) but ignores its response; that handler must stay side-effect free.
- **Latency**: every webhook hop < 0.5s through the tunnel; Retell register + SIP answer ≈ 1s. Vercel `lhr1` will be at least as good.
- **03 numbers**: available under Twilio's `Local` type (search `contains=443*`); `National` endpoint 404s for GB.
- **Bundles**: master account holds approved Local-Business and Mobile-Business bundles plus 5 validated GB addresses; buying is instant there. UK geographic numbers also need an `AddressSid` (error 21631). Subaccount bundle approval time is still unmeasured (spike subaccount left empty).
- **Softphone**: Twilio Voice JS SDK works from Chrome once the mic is granted; token must be minted on the account that owns the API key + TwiML app.
- **Improvement for production**: make the agent's opening line reason-aware (`transfer_failed` should apologise, not re-greet).
