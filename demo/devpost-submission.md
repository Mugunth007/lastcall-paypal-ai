# Devpost submission draft

## Project name

LastCall

## Elevator pitch

AI matches bakery surplus to your tastes and budget, with PayPal payment captured at pickup.

## About the project

### Inspiration

At closing time, a bakery can have fresh food left on the shelf while nearby people are looking for an affordable dinner or treat. A generic surprise bag may save food, but it does not tell a shopper whether the contents fit their budget, preferences, or ingredient exclusions. We built LastCall to make that last-minute match feel personal and practical.

### What it does

A shopper describes what they want, chooses a budget and pickup window, and selects ingredients to exclude. LastCall looks at the bakery's current inventory and proposes a small rescue bundle. The shopper reserves it and receives a six-digit pickup code after payment approval. At the counter, staff enter the code to confirm handoff. The PayPal sandbox integration is designed to **authorize at checkout and capture at pickup**; cancellation voids the authorization and returns items to inventory.

The app also includes an inventory editor, a live pickup list, rescue totals, subtle animations, and an optional ElevenLabs voice guide. The recorded walkthrough uses clearly labelled **simulated payments** because PayPal sandbox credentials have not yet been connected. The PayPal API path is implemented and tested with a local mock provider, but a live sandbox checkout has not been demonstrated.

### How we built it

We built the responsive interface with HTML, CSS, and vanilla JavaScript. A small Node.js HTTP server handles inventory, orders, pickup codes, and payment state. Ollama runs a local Qwen model to suggest item IDs from available stock. Server-side rules then check every suggestion against stock, budget, duplicate items, and the shopper's selected allergen labels. If the model is unavailable, a labelled rules-based matcher keeps the flow usable.

For payments, the server uses PayPal Orders v2 authorization and Payments v2 capture or void endpoints. It keeps separate buyer and bakery actions, stores order state locally for this prototype, and uses request IDs for payment operations. ElevenLabs generates short spoken guides that are cached locally; the browser's speech engine is the fallback. We recorded the demonstration in a real browser with Playwright and added narration with FFmpeg.

### Challenges and what we learned

The main challenge was keeping a creative AI suggestion consistent with hard constraints. A model can propose a useful combination, but it cannot be the final authority on price, stock, or ingredient labels. We learned to treat its output as a suggestion and validate the final bundle in deterministic server code, including a fresh check when the shopper reserves it.

Payment timing was another challenge. We built the order flow around authorization, pickup confirmation, capture, and cancellation instead of treating checkout as an instant sale. That made the pickup code central to both the customer experience and the payment state. We also learned to distinguish clearly between the simulated payment demo and a real PayPal sandbox transaction.

### What's next

Next we will connect a PayPal sandbox app and record its approval screen, add merchant sign-in and stronger order reconciliation, and test the experience with a real bakery's menu and pickup process. Ingredient labels are supplied by the bakery; shoppers still need to ask about shared equipment and cross-contact.

## Built with

JavaScript, Node.js, HTML, CSS, PayPal Orders API, PayPal Payments API, Ollama, Qwen, ElevenLabs, Playwright, FFmpeg

## Media

- Cover: `demo/lastcall-cover.png` (1500 x 1000, 3:2)
- Gallery: `demo/match.png`, `demo/pickup.png`, `demo/counter.png`, `demo/complete.png` (3:2)
- Video file: `demo/lastcall-demo.mp4` (49 seconds). Upload to YouTube as public or unlisted, then paste the YouTube URL into Devpost.

## Try it out links

No public app or GitHub repository URL is available yet. `http://localhost:3000` only works on the development machine. Add a public deployment and repository URL before submission.
