# Secure Shopping Agent

This service turns a Supabase-owned shopping list into a controlled Browserbase + Stagehand session. It uses Browserbase Model Gateway, so `BROWSERBASE_API_KEY` is the only model/browser credential. No OpenAI key is required.

## Safety model

- Stagehand may search, select products, and build a cart.
- Every run stops for a user approval tied to an exact maximum total and currency.
- The total is checked again immediately before the final order action.
- The automation is restricted to the merchant origin supplied in the request.
- Card numbers, CVVs, passwords, and one-time codes are never stored in Supabase or sent to the model.
- `saved_merchant` can submit using a payment method already saved in the user's merchant account.
- `secure_handoff` opens Browserbase Live View so the user can enter payment or complete 3-D Secure directly in the isolated browser session.
- Ambiguous final buttons, price changes, new currencies, 3-D Secure, and OTP prompts always fall back to handoff.

This design works across retailers without assuming they support Stripe Checkout. New merchants require a secure handoff once; merchants with an existing saved payment method can be automated after approval.

## Setup

1. Apply the SQL migration in `supabase/migrations` to the Supabase project.
2. Copy `.env.example` to `.env` and set the Browserbase and Supabase values.
3. Install and start:

```bash
npm install
npm run check
npm test
npm start
```

The frontend sends the user's Supabase access token as `Authorization: Bearer <token>`. The service uses the publishable key plus that token, so all database operations remain subject to RLS.

## API

### `POST /v1/shopping/runs`

```json
{
  "listId": "c2b5dd5a-2bd2-4e95-aed5-b8f75c1ad345",
  "merchantUrl": "https://shop.example.com",
  "items": [
    {
      "query": "unscented baby wipes",
      "quantity": 2,
      "maxUnitPrice": 12,
      "preferences": { "packSize": "80 or more" },
      "allowSubstitutions": false
    }
  ],
  "budget": 30,
  "currency": "USD",
  "paymentMode": "secure_handoff",
  "browserbaseContextId": "optional-persistent-context"
}
```

### `GET /v1/shopping/runs/:runId`

Returns the current status, reviewed total, and a Live View URL when user action is required.

### `POST /v1/shopping/runs/:runId/approve`

```json
{
  "approvedMaximum": 27.50,
  "currency": "USD"
}
```

Approvals expire after 15 minutes. If the cart total changes, the run returns to `awaiting_approval`.
