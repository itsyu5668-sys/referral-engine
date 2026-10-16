# Referral Engine API

Dropbox-style referrals for SaaS. API-first: founders integrate via REST + webhooks, with an optional themeable widget later.

## Quick start

```bash
cp .env.example .env   # fill in Supabase + Stripe keys
npm install
npm run dev
```

Run the SQL in `supabase/migrations/001_initial_schema.sql` in your Supabase SQL editor first.

## Endpoints

Auth: `Authorization: Bearer <token>` on all `/v1` routes except webhooks.
Use a Supabase JWT (dashboard) or an API key (`vouch_...`, server-to-server).

| Method | Path | Description |
|---|---|---|
| GET | /v1/workspaces/me | Get (or auto-create) your workspace |
| PATCH | /v1/workspaces/me | Update name / notification prefs |
| GET/POST | /v1/workspaces/me/members | List / invite teammates |
| DELETE | /v1/workspaces/me/members/:id | Remove a teammate |
| GET/POST | /v1/api-keys | List / generate API keys (secret shown once) |
| DELETE | /v1/api-keys/:id | Revoke a key |
| GET | /v1/programs | List programs with counts |
| POST | /v1/programs | Create a referral program |
| GET/PATCH | /v1/programs/:id | Program detail / update (pause, rename…) |
| GET | /v1/programs/:id/stats | Dashboard stats |
| GET/POST | /v1/programs/:id/rules | List / add reward rules |
| PATCH/DELETE | /v1/programs/:id/rules/:ruleId | Update / delete a rule |
| GET | /v1/programs/:id/links | Referral links with per-link counts |
| GET | /v1/programs/:id/rewards | Rewards queue (`?status=`) |
| POST | /v1/programs/:id/rewards/:rewardId/issue | Issue a pending reward now |
| GET | /v1/programs/:id/activity | Merged recent-activity feed |
| POST | /v1/referral-links | Generate (or fetch) a referrer's link |
| GET | /r/:code?to=https://... | Track click, 302 redirect |
| POST | /v1/attributions | Attribute a signup to a referrer |
| POST | /v1/webhooks/stripe | Stripe webhook (invoice.paid, subscription.deleted) |
| GET | /health | Health check |

## How it works

1. Founder creates a program, adds reward rules (trigger + conditions + actions).
2. Each user gets a unique link via `POST /v1/referral-links`.
3. Clicks hit `GET /r/:code` (first-party cookie friendly), redirect to signup.
4. On signup, founder's backend calls `POST /v1/attributions`.
5. On `invoice.paid`, the webhook marks conversion and evaluates `referee.first_payment` / `referee.signup` rules.
6. Rewards sit in `pending` until `issue_at`; the in-process worker issues them every 60s (Stripe credit, coupon, or outbound webhook).
7. On `subscription.deleted`, clawback cancels pending rewards within the rule's clawback window.

## Deploy

Render reads `render.yaml`. Set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_URL` in the Render dashboard.
