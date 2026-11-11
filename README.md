# LastCall

LastCall helps a bakery sell its end-of-day surplus. A customer describes what they want, an AI model proposes a bundle from available items, and server rules enforce the budget and selected allergen exclusions. PayPal authorizes the sandbox payment at checkout. The bakery captures it only after the customer gives a pickup code; a cancelled pickup voids the authorization.

## Run locally

Requires Node.js 20 or newer. No npm packages are needed.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm start
```

Open **http://localhost:3000**. Without PayPal credentials, the app uses clearly labelled demo payments. The complete reserve → approve → pickup → capture and cancel flows work in demo mode.

For the AI match, start Ollama in another terminal:

```powershell
ollama serve
```

Set `OLLAMA_MODEL` in `.env` to an installed model (`ollama list` shows them). This machine already has `qwen3-1.7b:latest`. If the local model is unavailable, the app shows a labelled rules-based fallback; the server still checks allergens, stock and budget. To get a standard Ollama model on another machine, run `ollama pull qwen3:1.7b` and set `OLLAMA_MODEL=qwen3:1.7b`.

## Connect the PayPal sandbox

1. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), create or open a **sandbox** REST app attached to a sandbox business account.
2. Put its sandbox client ID and secret in the prepared `.env` file as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Set a private `BAKERY_PIN` for the bakery counter. Keep `.env` out of Git.
3. Keep `PUBLIC_BASE_URL=http://localhost:3000` for local use, or set it to the public HTTPS address that buyers and PayPal can return to.
4. Restart `npm start`. The header should say **PayPal sandbox connected**. Use a separate sandbox personal account to approve the buyer checkout. Enter the bakery PIN to confirm pickup or cancel an authorization.

The integration uses [Orders v2 authorization](https://developer.paypal.com/platforms/checkout/standard/customize/auth-capture/) and [Payments v2 capture or void](https://developer.paypal.com/api/payments/v2). The order is marked as **pickup in store** in PayPal. These are sandbox transactions with test funds. The actual sandbox round trip needs your credentials; the included test suite exercises the same API path against a local PayPal-shaped test provider.

## Judge walkthrough

1. In **Bakery counter**, adjust available quantities under **What’s left on the shelf**.
2. In **Find food**, enter “A savory dinner and a sweet treat,” set a $15 budget and exclude nuts.
3. Pick a time and reserve the suggested bundle. Approve via PayPal sandbox or the labelled demo button.
4. Show the six-digit pickup code to the bakery. Enter it in **Bakery counter** and confirm pickup.
5. Create a second reservation, then cancel it before pickup. In sandbox mode PayPal voids the authorization and the items return to stock.

Run `npm test` to check matching constraints, buyer-only pickup codes, inventory, duplicate capture protection, cancellation and the PayPal authorization/capture/void API path.

This is a hackathon prototype for one fictional bakery. The counter uses a PIN for sandbox payment actions and has no staff accounts. The allergen filter uses bakery-entered labels and cannot guarantee the absence of cross-contact. A production rollout would need merchant authentication, verified menu data, webhooks and payment reconciliation after network failures.
