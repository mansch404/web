# Telegram Activity-Provider Bot — Plan

**Status:** Draft for review · **Date:** 2026-07-12

A Telegram bot that activity providers (APs) use as their single touchpoint with us:

1. **Send availability as free text** ("Di und Do nächste Woche 16–18 Uhr, max 8 Kinder, 12 €") — an LLM parses it into structured slots, the provider confirms the parse, and the slots are published into the booking system automatically.
2. **Receive booking requests and confirm them** — a customer's request (with up to 3 preferred slots, per the request-form design) lands as a Telegram message with buttons; one tap confirms a slot and notifies the customer.
3. **Talk to us** — anything that isn't a slot offer or a booking reply is relayed to an internal ops group, and our replies are relayed back.

Why Telegram: providers already live in chat, won't install another app, and won't fill in calendar UIs. Free text + one confirmation tap is the lowest-friction way to get inventory into the system.

---

## 1. Architecture

```
Provider (Telegram) ──▶ Telegram Bot API ──webhook──▶ POST /api/telegram   (Vercel function)
                                                          │
                                          ┌───────────────┼──────────────────┐
                                          ▼               ▼                  ▼
                                     Claude API      Upstash Redis      Ops group chat
                                   (parse/classify)  (state, slots,     (support relay,
                                                      bookings, dedupe)  escalations)

Booking frontend ──▶ GET /api/slots            (published availability feed)
Booking backend  ──▶ POST /api/telegram-notify (booking events in, shared secret)
Vercel cron      ──▶ /api/cron/reminders       (unanswered requests, weekly nudge)
```

Same stack as this site: plain Node Vercel functions, **zero npm dependencies** (Telegram, Anthropic, and Upstash all speak plain HTTPS/REST), secrets in Vercel env vars. Recommended to deploy as its **own Vercel project** (own repo or subdirectory) since it's a product component, not part of the personal site — but it can be prototyped here under `/api` first, since Vercel + KV are already wired up.

Planned layout:

```
api/
  telegram.js          # webhook endpoint: update router (messages, callback queries)
  telegram-notify.js   # inbound booking events from the booking system (Bearer NOTIFY_SECRET)
  slots.js             # GET published slots, for the booking frontend
  cron/reminders.js    # re-ping unanswered booking requests; weekly availability nudge
lib/
  tg.js                # sendMessage / editMessageText / answerCallbackQuery via fetch
  llm.js               # Claude call with forced tool-use schema
  store.js             # Upstash REST helpers (get/set/zadd/setnx…)
  texts.js             # all user-facing strings, DE + EN
```

Env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `NOTIFY_SECRET`, `OPS_CHAT_ID`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

---

## 2. Conversation flows

### 2.1 Onboarding

Providers are invited, never self-serve: ops runs `/invite Kletterhalle Nord` in the ops group → bot mints a one-time deep link `https://t.me/<bot>?start=<token>` (14-day TTL). Provider taps it, `/start <token>` binds their `chat_id` to the provider record, bot replies with a short "how this works" message. Unknown chats get a polite brush-off with a contact address. No token, no access — the chat-id allowlist is the auth model.

### 2.2 Slot intake (the core loop)

> **AP:** Nächste Woche Di und Do 16–18 Uhr Kinderklettern, max 8 Kinder, 12 €
>
> **Bot:** Ich habe 2 Slots verstanden:
> ① Kinderklettern — Di 21.07. 16:00–18:00 — max 8 — 12,00 €
> ② Kinderklettern — Do 23.07. 16:00–18:00 — max 8 — 12,00 €
> `[✅ Veröffentlichen]` `[✏️ Korrigieren]` `[❌ Verwerfen]`
>
> **AP:** *(taps ✅)*
>
> **Bot:** Online ✔️ Beide Slots sind jetzt buchbar.

- Every parse produces a **draft**, never a live slot. The provider's ✅ is what publishes. This is the safety valve for LLM mistakes and for prompt-injection via message text — parsed content can only ever become a draft awaiting human confirmation, never trigger an action directly.
- **Corrections are free text too:** after ✏️ (or just replying while a draft is open), "nein, Donnerstag erst ab 17 Uhr" re-parses with the current draft as context and shows an updated summary.
- **Ambiguity:** if the LLM can't resolve something (no year, "afternoon", missing capacity where required), it returns a `clarification_needed` question and the bot asks it instead of guessing.
- Validation after the LLM, before the draft is shown: dates in the future (≤ 6 months out), `end > start`, sane capacity/price bounds, overlap check against the provider's existing published slots (overlaps become a ⚠️ warning on the draft, not a hard block).

### 2.3 Booking requests → confirmation

Per the request-form design, a customer selects **up to 3 alternative slots** in one request; the provider confirms exactly one (or declines all):

> **Bot:** 📩 Neue Buchungsanfrage — Familie M., 2 Kinder
> Wunschtermine:
> ① Di 21.07. 16:00 Kinderklettern
> ② Do 23.07. 16:00 Kinderklettern
> ③ Do 30.07. 16:00 Kinderklettern
> `[① bestätigen]` `[② bestätigen]` `[③ bestätigen]` `[Alle ablehnen]`
>
> **AP:** *(taps ①)*
>
> **Bot:** ✔️ Bestätigt: Di 21.07. 16:00 für Familie M. (2 Plätze). Die Familie wird benachrichtigt.

- The booking system POSTs the request to `/api/telegram-notify`; the bot renders it and records the pending booking.
- On tap: capacity is decremented on the confirmed slot, the other requested options are released, the booking backend is called back (or the Redis booking record is updated, see §5), and the message's keyboard is replaced with the outcome so it can't be double-tapped.
- "Alle ablehnen" asks for an optional one-line reason (free text) which is passed back to the customer flow.
- **Reminders:** cron re-pings the provider after ~4h and ~24h of silence; after 48h it escalates into the ops group. Response-time stats per provider come free from these timestamps.

### 2.4 Talking to us (ops relay)

Any message that isn't a slot offer or tied to an open draft/booking (the LLM classifies intent in the same call as parsing) is treated as a support message:

- Bot forwards it into the internal **ops group** (`OPS_CHAT_ID`), tagged with the provider name.
- A team member **replies to the forwarded message** in the group; the bot relays the reply back to the provider. The reply-to message id → provider chat mapping lives in Redis.
- `/support …` forces this path explicitly; escalations from unanswered bookings land in the same group.

### 2.5 Commands

`/start <token>` onboarding · `/slots` list upcoming published slots · `/cancel` cancel a slot via numbered pick (if it has confirmed bookings → routed to ops instead of silently dropping customers) · `/bookings` pending + upcoming · `/support` message the team · `/help`. Everything else is free text.

---

## 3. LLM parsing spec

- **Model:** `claude-haiku-4-5` — extraction at this difficulty doesn't need more, and it keeps cost/latency negligible (~1–2k tokens ≈ tenths of a cent per message; a few seconds). Escalation path to Sonnet if real-world parse quality disappoints.
- **Mechanism:** single call with a **forced tool choice**, so output is always schema-valid JSON — classification and extraction in one pass:

```jsonc
{
  "intent": "slots_offer | draft_correction | support_message | booking_related | other",
  "slots": [{
    "activity": "Kinderklettern",
    "date": "2026-07-21",          // resolved to absolute dates by the LLM
    "start": "16:00",
    "end": "18:00",                 // null if not stated and no default
    "capacity": 8,                  // null if not stated
    "price_eur": 12.0,              // null if not stated
    "location": null,               // provider default assumed unless stated
    "recurrence": { "freq": "weekly", "until": "2026-09-01" },  // or null
    "notes": null
  }],
  "clarification_needed": null      // or a question, in the provider's language
}
```

- **Prompt context:** today's date + weekday in `Europe/Berlin`, the provider's profile (name, known activities, default venue/price/capacity from past slots), the open draft if correcting, and few-shot examples of typical German provider shorthand ("Di+Do 16-18", "KW 31 jeden Tag vormittags", "nächsten Samstag fällt aus").
- **Relative dates** ("next week", "übermorgen") are resolved by the LLM against the injected date; code re-validates. Recurrences are expanded into concrete slots **at publish time**, capped (e.g. 13 weeks), so the provider confirms actual dates, not a rule.
- **Language:** replies mirror the provider's language; templates exist in DE and EN, DE-first market.
- **Trust boundary:** LLM output is data, never instructions. It's schema-validated, bounds-checked, and only ever rendered into a draft for human confirmation. The model has no tools besides the output schema and no ability to address messages.

---

## 4. Data model (Upstash Redis)

| Key | Type | Content |
|---|---|---|
| `ap:<providerId>` | hash | name, tgChatId, locale, tz, defaults (venue, price, capacity) |
| `tg:chat:<chatId>` | string | providerId (auth lookup on every update) |
| `invite:<token>` | string | providerId, TTL 14 d |
| `draft:<chatId>` | JSON | parsed slots, source message ids, version counter |
| `slot:<slotId>` | JSON | providerId, activity, startISO, endISO, capacity, booked, priceEur, status |
| `slots:prov:<providerId>` | zset | slotIds scored by startTs (listing, overlap checks) |
| `booking:<bookingId>` | JSON | customerRef, requested slotIds (≤3), status, confirmedSlotId, timestamps |
| `relay:<opsMsgId>` | string | provider chatId (support reply routing), TTL 30 d |
| `tg:update:<updateId>` | SETNX | idempotency guard, TTL 24 h |

Times are stored as ISO 8601 with explicit `Europe/Berlin` offsets — DST-proof and unambiguous for any future consumer.

---

## 5. Integration with the booking system

Two integration seams, both thin:

- **Availability out:** `GET /api/slots?providerId=…` serves published slots as JSON for the booking frontend/request form.
- **Bookings in/out:** the booking system POSTs request events to `/api/telegram-notify` (Bearer `NOTIFY_SECRET`) and receives confirm/decline callbacks at a URL it provides — or, **MVP variant:** the Redis slot + booking records here *are* the system of record, and the request form is a small page reading `/api/slots` and POSTing requests. Which of the two depends on what already exists on the booking side (open question #1).

---

## 6. Failure modes & mitigations

| Risk | Mitigation |
|---|---|
| LLM misparses ("Do" → wrong week) | Draft + explicit ✅ before anything goes live; corrections are cheap |
| Prompt injection in provider text | LLM output is draft-data only; no direct actions; allowlisted chat ids; ops relay renders text, never executes it |
| Telegram webhook retries / duplicate updates | `SETNX tg:update:<id>` dedupe; callback handlers idempotent |
| Double-tap on confirmation buttons | Keyboard replaced via `editMessageText` on first tap; booking status check before applying |
| Two customers race for the last place | Capacity check + decrement is atomic (Lua/`DECR` guard) at confirm time; loser's request falls back to their alternative slots |
| Provider ignores booking requests | 4 h / 24 h reminders, 48 h ops escalation, response-time tracking |
| Webhook spoofing | `X-Telegram-Bot-Api-Secret-Token` checked; unknown chat ids ignored; internal endpoints Bearer-authed |
| Vercel function limits | All handlers stateless and < 10 s (LLM call is the ceiling); heavy work is per-message, not batch |

---

## 7. Build phases

| Phase | Scope | Effort |
|---|---|---|
| **1 — Walking skeleton** | BotFather setup, webhook + secret, onboarding/invites, `/help`, ops-group relay both directions. *Providers can already "communicate with us".* | ~1 day |
| **2 — LLM slot intake** | Claude parse + intent classification, draft/confirm/correct loop, validation, publish to Redis, `/slots`, `GET /api/slots` feed | ~1–2 days |
| **3 — Booking loop** | `/api/telegram-notify`, 3-option request messages, confirm/decline + capacity accounting, customer-side callback, cron reminders + escalation | ~1–2 days |
| **4 — Polish (as needed)** | Weekly "send next week's slots" nudge, recurring-slot QoL, voice-note transcription, editing published slots, multiple staff per provider, per-provider stats | ongoing |

MVP (1–3) ≈ **3–5 focused days**. Running cost ≈ €0: Telegram free, Vercel hobby, Upstash free tier, Haiku pennies/month at realistic volumes.

---

## 8. Open questions

1. **System of record:** does a booking backend with an API already exist (Flits? the stealth product?), or is the MVP variant in §5 — Redis here as the slot/booking store — the starting point?
2. **Request form:** does the customer-facing form (with the 3-slot selection) exist, or is it part of this build?
3. **Who is "us":** which team members join the ops group; who owns escalations?
4. **Payments & cancellation policy:** out of scope for the bot (assumed handled at booking-system level) — confirm.
5. **Provider accounts:** one Telegram user per provider, or multiple staff members per provider from day one? (Data model supports N chat ids → 1 provider either way.)
6. **Repo/home:** prototype in this repo vs. fresh Vercel project from the start (recommended).
