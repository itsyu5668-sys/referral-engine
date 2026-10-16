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

| Method | Path | Description |
|---|---|---|
| POST | /v1/programs | Create a referral program |
| POST | /v1/programs/:id/rules | Add a reward rule |
| GET | /v1/programs/:id/stats | Dashboard stats |
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
