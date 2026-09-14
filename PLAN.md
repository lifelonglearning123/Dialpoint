# UK Numbers + AI Receptionist + Routing — Product & Build Plan

Status: scoping, decisions locked 2026-09-13. White-label only: no first-party brand.
Folder: `C:\python\telephone buying` (nested in the C:\python parent repo; make it its own repo before first deploy, like aibrain).

## 1. What we are building

A storefront where a UK business buys a phone number in minutes, then decides *who answers it*: them, an AI receptionist, or a mix. The mix is the product. Number-only sites (the incumbents) sell forwarding and voicemail; we sell a routing engine where the AI can answer first, answer only when the owner is busy, or answer only after hours, and hand over to a human either way.

Customer journeys:

1. **Buy** — pick a number type (local 01/02 by town, national 03, freephone 0800, mobile 07), search, reserve.
2. **Verify** — Ofcom KYC: business details + UK address (+ proof docs). Number activates on bundle approval.
3. **Answer** — choose where humans answer: mobile/landline forward and/or the in-browser softphone.
4. **AI** — optional add-on. Build the receptionist in Signal's 4-step wizard (SSO hop), come back.
5. **Route** — pick a routing template, tweak the rules (hours, overflow timeout, IVR, VIP callers).
6. **Live** — call log with recordings, transcripts, voicemails, AI summaries, minute usage and caps.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Carrier | Twilio, Chao's existing master account (the one in Signal's `TWILIO_ACCOUNT_SID`). **One Twilio subaccount per customer org**, created at first purchase. Numbers, regulatory bundles, recordings and usage all live in the customer's subaccount, so per-customer cost is read straight from Twilio and a churned customer is closed by suspending the subaccount. |
| Identity | **Shared login with Signal**: this app runs on Signal's Supabase project and `auth.users`; same emailed 6-digit OTP login; same `profiles` / `agencies` rows. Its own tables sit in a separate Postgres schema `tb`. |
| Number types | Local 01/02, national 03, freephone 0800, mobile 07. Porting in V2. |
| AI layer | Signal (Retell). Customer builds the agent in Signal's wizard via SSO; this app stores the resulting agent id and routes to it. |
| Human leg | PSTN forward (1..n numbers) + browser softphone (Twilio Voice JS SDK). Ring groups / SIP trunk in V2. |
| Answer check | "Press 1 to accept" whisper on every forwarded leg, so a mobile's own voicemail can never win the call. |
| Routing (V1) | Human-first → AI on busy/no-answer; after-hours + bank holidays → AI; AI-first → warm transfer; IVR menus + caller rules (VIP bypass, blocklist, known-caller). |
| Scope (V1) | Inbound only, plus voicemail with transcription. No outbound, no SMS. |
| Tenancy | Central multi-tenant: one Vercel project, Signal's Supabase, agency resolved by hostname (Canopy Studio pattern). |
| Go-to-market | **White-label only.** Each agency runs it on their own domain with their branding and Stripe Connect account; there is no first-party storefront. Chao's own agencies (macaws.ai etc.) are just agency rows. |
| Pricing | Per number: **fixed monthly fee + usage charge** (forwarded/inbound/softphone minutes over an allowance), both **charged automatically** to a card on file via a Stripe subscription on the agency's Connect account (section 7a). AI receptionist is a separate Signal subscription with its own minutes and caps. Plans stored as data per agency. |

## 3. Carrier facts that shape the product (verified 2026-09-13)

**Twilio UK number costs** (GBP, list price):

| Type | Monthly | Inbound /min |
|---|---|---|
| Local 01/02 | £3.50 | £0.010 |
| Mobile 07 | £2.50 | £0.010 |
| Freephone 0800 | £2.70 | £0.0798 |
| Outbound to UK landline / mobile | — | £0.0158 / £0.0305 |

The forwarded human leg is an outbound call, so a 10-minute forwarded call to a mobile costs us ~£0.41 in carrier fees before any AI minutes. Number-only tier must price for this (or cap forwarded minutes).

**Regulatory (Ofcom KYC via Twilio Regulatory Compliance)** — since 30 Sep 2024 every UK number (local, national, mobile, toll-free) must sit in an approved RC bundle before it can take calls.

- Local/national: end user (individual or business) needs a **UK address, no PO Box**, plus business registration details and an authorised rep, or ID + proof of address for individuals.
- Mobile / toll-free: same documents, but the address may be anywhere in the world.
- Bundles, end users, addresses and supporting documents can all be created by API. Twilio reviews them; approval is hours to days, not seconds.

Product consequence: "live in 5 minutes" is not honest for a fresh UK number. The buy flow must (a) collect KYC up front, (b) show a "verifying, usually under 24h" state, (c) auto-assign the reserved number when Twilio fires the bundle-approved event. Reuse of an already-approved bundle for a customer's second number is instant.

Confirmed 2026-09-13: UK 03 numbers are in Twilio's `Local` inventory (search `contains=443*`). Geographic numbers additionally require a validated `AddressSid` on the (sub)account, not just the bundle.

**Retell handoff** — Retell's custom-telephony path: call `registerPhoneCall({agent_id, from_number, to_number, direction, retell_llm_dynamic_variables})`, get a `call_id`, then dial `sip:{call_id}@sip.retellai.com` within 5 minutes. Twilio can do this mid-call with `<Dial><Sip>`. That means **Twilio keeps control of the parent call** and can try humans first, then splice the AI in, which is the whole routing engine. Retell's transfer tool (cold, warm, agentic warm) accepts a dynamic-variable destination.

## 4. Routing engine design

Twilio owns every inbound call. Our voice webhook is a small state machine that evaluates the number's **routing policy** and returns TwiML for the next step. Each step reports back (Dial `action`, Gather `action`, status callbacks) and the machine continues.

Policy = ordered list of rules evaluated per call:

```
when  : schedule(in_hours | out_of_hours | holiday) & caller(vip | blocked | known | unknown) & ivr_choice(n)
then  : one of
        ring_humans(targets[], timeout, whisper)       -> on busy/no-answer/declined: next
        ai(agent_id, dynamic_vars)                     -> Retell; transfer destination(s) passed as vars
        ivr(prompt, options{digit -> sub-policy})
        voicemail(greeting, transcribe)
        reject | forward_raw(number)
```

Templates shipped in V1 (the customer picks one, then edits):

1. **You first, AI backup** — `in_hours: ring_humans(30s) → ai`; `out_of_hours: ai`.
2. **AI reception** — `ai` always; agent transfers to humans when appropriate (Retell warm transfer to `{{transfer_number}}`).
3. **Office hours only** — `in_hours: ring_humans → voicemail`; `out_of_hours: ai`.
4. **Front desk menu** — `ivr("1 sales, 2 support") → per-option sub-policy`.

Mechanics:

- **ring_humans** → `<Dial timeout=N action=/voice/after-dial>` containing `<Number url=/voice/whisper>` per PSTN target and `<Client>` per softphone user, rung simultaneously. The whisper is `<Gather numDigits=1>` "Call for {business}, press 1 to accept"; no keypress → `<Hangup>` on that leg only, so Twilio sees it as unanswered and the parent call moves to the next rule. Caller hears ringback or hold music throughout.
- **ai** → server asks Signal (`/api/partner/voice/register`, section 6) which calls Retell `registerPhoneCall` with dynamic vars (`business_name`, `caller_number`, `transfer_number`, `reason: overflow|after_hours|ai_first`), returns `<Dial><Sip>sip:{call_id}@sip.retellai.com</Sip></Dial>`.
- **AI → human transfer** (settled by the spike, 2026-09-13): Retell's native transfer tool **cannot** transfer a call that arrived over SIP from our number ("number to transfer from is not valid"). The agent therefore gets a **custom tool** that calls back to this app, and this app redirects the Twilio parent call (`calls(parentSid).update({twiml})`) to `ring_humans` with a transfer whisper. Not accepted → the AI is re-registered with reason `transfer_failed` and takes a message. Proven live both ways. Consequence for the Signal contract: the agent's tool points at Signal, Signal calls this app's `transfer` endpoint with the call ref (section 6).
- **schedule** → per-number weekly hours in `Europe/London`, plus UK bank holidays (gov.uk JSON feed, cached) and custom closures.
- **caller rules** → lookup on E.164 caller: blocklist → reject; VIP → straight to owner's mobile with no whisper; known contact → name in whisper and in AI dynamic vars.
- **voicemail** → `<Record>` with our own transcription (OpenAI) and email/notification; also the terminal fallback when the AI add-on is off or over cap.
- **Cap at 100%** → policy's `ai` steps are skipped and the configured cap action runs (voicemail or forward), matching Signal's semantics.

Latency: Twilio waits on the webhook, so policy evaluation must be one DB read (policy JSON cached per number) and no LLM in the hot path. Run voice routes on the Node runtime in `lhr1` (London) region.

## 5. Softphone

Twilio Voice JS SDK. Each user gets a `<Client>` identity `user:{uuid}`; access tokens minted from a TwiML App per agency subaccount. Browser shows caller number, contact name, which number they dialled and the route reason. Answer/decline; decline behaves like "no keypress" for the routing engine. Presence (online/offline) feeds the router so we do not ring a closed browser.

## 6. Boundary with Signal (decided 2026-09-13)

**This app owns:** number search, purchase, KYC/bundles, number billing, the routing policy and its evaluation on every inbound call, human legs (forward, softphone), voicemail, the call log. **Signal owns:** everything AI: building the receptionist, running it, transferring from it, metering and billing AI minutes, caps and alerts. This app never holds a Retell key and never bills an AI minute.

At call time the only thing this app asks Signal is "take this call now". Contract (all new, small additions on Signal's existing partner API):

| Step | Direction | Endpoint | Purpose |
|---|---|---|---|
| Link | this app → Signal | `POST /api/partner/sso/start` `{agency_id, client_id, user_id, return_url}` → signed URL | Same `auth.users` row on both sides, so this is a **cross-domain session handoff**, not account creation: Signal mints a single-use OTP for the existing user (its GHL handoff pattern, `src/lib/ghl/handoff.ts`), opens the wizard with the **phone step skipped** (the number lives here), and on go-live redirects to `return_url?agent_ref=…` |
| Status | this app → Signal | `GET /api/partner/agents?org_ref=` | Is the agent live, suspended, or over cap? Drives whether `ai` steps are active in the policy |
| Hand-off | this app → Signal | `POST /api/partner/voice/register` `{agent_ref, from, to, reason, vars}` → `{sip_uri, call_ref}` | Signal calls Retell `registerPhoneCall` with its own key and returns `sip:{call_id}@sip.retellai.com`; this app answers with `<Dial><Sip>` |
| Result | Signal → this app | webhook `call.ended` `{call_ref, outcome, transferred_to, summary, transcript_url}` | Fills the call log here; minutes were already metered by Signal's Retell webhook |
| Cap | Signal → this app | webhook `agent.status` `{agent_ref, status}` | When Signal hits 100% and suspends, this app's router skips `ai` and falls to the policy's fallback (voicemail or forward) |
| Transfer | Signal → this app | `POST /api/partner/transfer` `{call_ref, reason}` → `{ok}` | The agent's transfer tool (a custom tool Signal configures on every agent used through this app) fires this; this app redirects the parent Twilio call to `ring_humans`. Replaces Retell's native transfer, which cannot dial out on SIP-delivered calls. |

Transfer from AI back to a human is configured and executed inside Signal (Retell transfer tool, destination = the transfer number Signal stores per client). This app passes `transfer_number` in `vars` at hand-off so it stays in sync with the human targets configured here.

Billing consequence: a customer with the AI add-on holds **two subscriptions**, number here and receptionist in Signal, under one identity (SSO). The storefront presents them as one bundle; Stripe sees two.

Signal changes required (tracked in Signal, not here): partner SSO start (session handoff), wizard "agent-only" mode without the phone/number step, `voice/register`, two outbound webhooks. No join key is needed: both apps share `agencies`, `clients` and `profiles`, so `client_id` is the same id on both sides.

## 6a. Shared identity and tenancy (decided 2026-09-13)

- Same Supabase project as Signal (`voice-retell-elevenlabs/.env.local` → `NEXT_PUBLIC_SUPABASE_URL`). This app gets its own env with the same URL and keys, plus its own `PARTNER_API_SECRET` value for calling Signal.
- Shared tables, owned by Signal's Drizzle migrations: `auth.users`, `profiles` (role, agency_id), `agencies` (branding, domains, Stripe Connect), `clients` (the customer org), `client_memberships`. This app reads them and creates `clients` + memberships at checkout via the same shape Signal's `golive.ts` uses. It never adds columns to Signal's tables.
- This app's own tables live in schema **`tb`** (section 8) with its own migrations, keyed by `clients.id` and `agencies.id`. Supabase exposes `tb` by adding it to the API "exposed schemas" list.
- Login: the same OTP flow (copy `src/app/login/actions.ts`). Sessions are cookies per domain, so a user logged into Signal's domain is not automatically logged into this app's domain; the SSO handoff in section 6 covers the hop in both directions.
- Agency resolution: same rule as Signal, hostname → `agencies.custom_domain`; unknown host → a neutral "not configured" page, never a default brand. An agency that white-labels both products has one row and one Stripe Connect account.
- Roles: reuse `user_role` (client_admin, client_user, agency_staff, super_admin).

Twilio subaccounts: created with the master creds (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` from Signal's env) as `friendlyName = client:{clients.id}`; SID + auth token stored encrypted in `tb.twilio_accounts` using the same AES-256-GCM helper pattern as Signal's `credentials.ts`. Regulatory bundles, addresses, numbers, TwiML Apps (softphone) and recordings are all created inside the subaccount. Twilio's default limit is 1,000 subaccounts per master; request a raise before that. Suspending a subaccount (`status: suspended`) is the non-payment action; closing releases its numbers, so close only after the grace period.

## 7. Tenancy, brand, billing

- `agencies`, `clients`, `profiles`, `client_memberships` are Signal's tables, shared (section 6a). Hostname → agency in middleware; every storefront is an agency's.
- Each `clients` row that buys a number gets a Twilio subaccount (`tb.twilio_accounts`).
- Plans as data: `plans` per agency (see 7a). AI add-on pricing and AI minutes are Signal's, not ours.

## 7a. Billing requirement (added 2026-09-13)

**Requirement.** A client pays two things every month, and both must be collected automatically with no manual invoicing: a **fixed monthly fee per number**, and a **usage charge** that depends on how the number was used that month. The client enters a card once at purchase; from then on the platform charges them every month without anyone touching it.

**What counts as usage** (all metered here, from Twilio):

| Meter | Source | Unit |
|---|---|---|
| Forwarded minutes | outbound legs to the client's mobile/landline (`<Number>` in `ring_humans`) | minutes, rounded up per leg |
| Inbound minutes | the caller's leg (matters for 0800, where inbound costs 8p/min) | minutes |
| Softphone minutes | `<Client>` legs | minutes |
| Voicemail transcription | per voicemail transcribed | count |

AI minutes are metered and charged by Signal on its own subscription; they never appear on this invoice.

**Plan shape** (`tb.plans`, one or more per agency, retail prices set by the agency, wholesale floor set by Chao):

```
number_monthly_pence         e.g. 900     fixed, per number
included_minutes             e.g. 100     pooled across the client's numbers, per month
per_minute_pence             e.g. 5       overage on forwarded + inbound + softphone minutes
freephone_inbound_pence      e.g. 12      0800 inbound minutes always billed (no allowance)
voicemail_transcribe_pence   e.g. 0|10
billing_anchor               calendar month | purchase date
```

**Stripe mechanics** (on the agency's Connect account, platform fee taken per invoice):

1. **Checkout** — first purchase runs Stripe Checkout in `subscription` mode with `payment_method_collection: always`, creating a Stripe Customer on the agency's connected account and a Subscription with two items: a **licensed price** for the number (quantity = number of active numbers) and a **metered price** for usage. Card is saved and set as default.
2. **Numbers added or removed** later change the licensed quantity with proration; no new checkout.
3. **Usage** — every Twilio status callback writes a `tb.usage_ledger` row per leg. A cron (hourly) sends each new row as a **Stripe Billing Meter event** (`meter_events`, idempotent on `call_sid+leg`), so the subscription's metered item accumulates through the month. Included minutes are applied as a free tier on the meter price (graduated tiers: first N free, then `per_minute_pence`); 0800 inbound uses a separate meter with no free tier.
4. **Invoice** — at period end Stripe generates one invoice (number fee + usage), finalises it after the one-hour grace, and charges the default card automatically. Invoice email comes from the agency's Stripe branding.
5. **Failure** — Stripe Smart Retries over 14 days with dunning emails. Webhook `invoice.payment_failed` → client flagged `past_due`, banner in the app. After the retry window `customer.subscription.updated` (status `unpaid`) → this app **suspends the Twilio subaccount** (calls stop, number kept). `invoice.paid` → resume. Number release only after a further 30 days, so a late payer never loses their number by accident.
6. **Cancellation** — cancel at period end; number released at the end of the paid period; final usage invoice charged automatically.
7. **Visibility** — client dashboard shows current-period fixed fee, minutes used vs included, projected usage charge, next charge date, and links to Stripe-hosted invoices and the customer portal for card changes. Agency admin sees the same per client plus the platform-fee and Twilio cost lines.

**Tables added**: `tb.plans`, `tb.subscriptions` (client_id, stripe_customer_id, stripe_subscription_id, status, licensed_item_id, metered_item_id, period_start/end), `tb.usage_ledger` (client_id, call_sid, leg_sid, meter, quantity, occurred_at, stripe_meter_event_id), `tb.stripe_events` (dedupe). Stripe events arrive on this app's own Connect webhook endpoint; Signal's `stripe_events` table is not shared.

**Wholesale vs retail.** Twilio bills Chao's master account for every subaccount. Each agency's plan must clear the wholesale floor (number cost + carrier minutes + platform fee); this app enforces the floor when an agency edits a plan and reports per-agency margin monthly.

## 8. Data model (Supabase, schema `tb`)

```
-- shared with Signal (public schema, Signal-owned): agencies, clients, profiles, client_memberships
-- this app (schema tb), every row keyed by client_id -> public.clients.id
twilio_accounts    (client_id, subaccount_sid, auth_token_enc, status, twiml_app_sid)
numbers            (client_id, twilio_sid, e164, type, status: reserved|verifying|active|suspended, bundle_id)
regulatory_bundles (client_id, twilio_bundle_sid, end_user_sid, address_sid, status, docs[])
routing_policies   (number_id, version, json, active)   -- versioned, one active per number
schedules, closures (org_id, weekly hours, holiday set, ad-hoc closures)
human_targets      (org_id, kind: pstn|client, value, label, priority)
contacts           (org_id, e164, name, tag: vip|blocked|known)
ai_agents          (org_id, signal_agent_id, retell_agent_id, status)
calls              (number_id, twilio_call_sid, from, to, started, ended, outcome, route_trace jsonb, retell_call_id)
call_legs          (call_id, kind: whisper|human|ai|voicemail, target, status, duration)
recordings, voicemails (transcript, summary)
usage_ledger       (org_id, kind: carrier|ai, minutes, cost, source_id, period)
plans, subscriptions
```

`route_trace` records every rule evaluated and every leg outcome per call, which is the debugging surface for "why did the AI answer".

## 9. Stack

Next.js 16 (App Router) + Supabase + Vercel + Stripe Connect + Twilio (Voice, Regulatory Compliance, Voice SDK) + Retell via Signal + OpenAI (transcription, voicemail summaries). Same conventions as Canopy Studio / Signal. Dev with `next dev --webpack` on this machine; never build while dev runs.

## 10. Phases

**Phase 0 — Spike. DONE 2026-09-13, verdict GO** (see SPIKE.md). Test line +44 20 4652 7858 on the master account; all routing legs proven live including AI→human transfer via webhook + Twilio redirect.

**Phase 1 — BUILT 2026-09-13 (commit daf82ca).** Original scope: Tenancy + auth, number search/reserve/buy, KYC bundle flow with status polling and the bundle-approved webhook, routing policy engine with templates 1 and 3, human targets, voicemail + transcription, call log with route trace.

**Phase 2 — AI hand-off (week 3).** Signal side: partner SSO start, agent-only wizard mode, `voice/register`, `call.ended` + `agent.status` webhooks, `org_ref` join key. This side: "Add AI receptionist" SSO hop, `ai` policy step via `<Dial><Sip>`, AI-first template, cap-aware fallback, IVR template, caller rules.

**Phase 3 — BUILT 2026-09-14, awaiting live test (migration 0001 + Stripe webhook secret + first published plan).** Original scope: Plans as data per agency, Stripe Checkout → subscription (licensed number item + metered usage item), Billing Meter events from Twilio callbacks, automatic invoicing, dunning → subaccount suspend/resume, agency admin (branding, custom domain, plans, wholesale vs retail price view), agency-facing landing page template with number search above the fold.

**Phase 4 — Polish.** Softphone presence, bank-holiday feed, notifications (missed call, voicemail, cap alerts), route-trace debugger UI, porting request form (manual fulfilment).

## 11. Open questions

- Do agencies pay Twilio cost pass-through or is it baked into wholesale pricing? (Affects whether subaccount spend is visible to them.)
- 03 national number availability on Twilio GB.
- Does the direct-to-SME brand also upsell Signal outbound products, or stay inbound-only?

## 12. Signal codebase findings (read 2026-09-13)

Work against `C:\python\Signal\voice-retell-elevenlabs` (own repo `lifelonglearning123/voice-monitor`, branch `feat/demo-call-provision`; the `Signal` folder is only a container). Drizzle schema in `src/db/schema.ts`, single `public` schema, migrations to `0053`.

**Already built in Signal that this product needs:**

| Need | Signal has | Where |
|---|---|---|
| Host-based multi-tenancy | `agencies.custom_domain` (+verified) → agency; fallback `DEFAULT_AGENCY_SLUG`; branding, locale, prices per agency | `src/lib/tenancy/resolve.ts` |
| Auth | Supabase Auth, emailed 6-digit OTP; roles super_admin / agency_staff / client_admin / client_user | `src/lib/auth.ts`, `src/app/login/actions.ts` |
| Buy UK numbers | search / buy / link / release + number types; `BUNDLE_REQUIRED = { GB: [LOCAL, MOBILE, TOLLFREE] }`; regulatory bundle creation, webhook, crons | `src/lib/bots/twilio.ts`, `src/lib/twilio/regulatory.ts`, `/api/twilio/*`, `/api/cron/twilio-bundles` |
| Routing engine | modes `ai_first / person_first / repeat_to_person`; ring seconds, **press-1 confirm keypress**, caller-id choice, business hours (`clients.business_hours` + timezone, outside hours → AI), block lists, `call_attempts` log | `src/lib/calls/routing-rules.ts`, `/api/voice/inbound`, `/inbound/whisper`, `/inbound/person-result`, `docs/call-routing-who-answers-first.md` |
| Twilio → Retell | `<Dial><Sip>` to `sip.retellai.com` in screening mode (VoiceUrl on our webhook), Elastic SIP trunk otherwise; forward URL HMAC'd, destination read from DB at call time | `src/lib/voice/forward-url.ts`, `RETELL_SIP_HOST` |
| Minute caps | `client_billing_config` (postpaid/prepaid, included minutes, cap, `cap_action` alert_only/suspend/transfer, transfer_number), `usage_counters` with `alert_80_fired_at` / `cap_hit_at`, `credit_ledger` | `src/lib/usage/enforcement.ts`, `suspension.ts` |
| Billing | Stripe Connect Standard, direct or destination charges, per-agency `client_price_pence` (9900 GBP) or `pricing_plans` with included minutes / overage / human rate / trial, `plan_links` | `src/lib/stripe/*`, `docs/billing-two-*.md` |
| Sibling-app bridge | Partner API with bearer secret: `/api/partner/voice/authorize`, `/call`, `/usage` (records + meters calls into the shared ledger). Join key is `clients.ghl_location_id` today | `src/lib/partner/voice-credit.ts` |
| SSO precedent | GHL SSO: encrypted payload → JIT profile → single-use Supabase OTP redeemed client-side | `src/lib/ghl/sso.ts`, `identity.ts`, `handoff.ts` |
| Wizard | `/bots/new` → `/1` → `/2` → `/6` (phone + checkout + activate); produces `bots.retell_agent_id`; all routes session-gated, no programmatic create | `src/lib/bots/wizard/steps.ts`, `src/lib/bots/deploy.ts`, `golive.ts` |

**Not in Signal (net-new either way):** voicemail (`<Record>` appears nowhere), transcription of voicemail, IVR menus, bank holidays / ad-hoc closures, VIP / known-caller rules (only blocklists), multiple human targets and ring groups, browser softphone (`<Client>`), a number-only plan with no AI agent, Twilio subaccounts (Signal uses one Twilio account **per agency**, encrypted in `agencies.twilio_*`), and a number-first storefront UX.

**Decision (Chao, 2026-09-13): separate app.** This app is the number storefront, number billing and call-handling engine; Signal is the AI. See section 6 for the contract. Signal's `routing-rules.ts`, `twilio.ts` and `regulatory.ts` are the reference implementations to lift patterns from (whisper TwiML, bundle resolution, HMAC'd callback URLs), not shared code. Signal's own per-agency Twilio accounts stay for Signal-native customers; numbers sold here live in this app's Twilio master account with a subaccount per agency.
