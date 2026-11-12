import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedInventory, pickupWindows } from './catalog.mjs';
import { matchWithOllama, matchWithEmbeddings, normalizeSelection } from './matching.mjs';
import { voiceCues, elevenLabsSpeech } from './voice.mjs';
import { get as getBlob, put as putBlob, BlobPreconditionFailedError } from '@vercel/blob';

const root = dirname(fileURLToPath(import.meta.url));
const dataPath = process.env.DATA_PATH || join(root, '.data', 'state.json');
const remoteState = Boolean(process.env.VERCEL && process.env.BLOB_READ_WRITE_TOKEN);
const stateBlobPath = 'lastcall/state.json';
let stateEtag = null;

async function loadEnvFile() {
  try {
    const contents = await readFile(join(root, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
await loadEnvFile();

const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${port}`);
const paypalEnabled = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const bakeryPin = process.env.BAKERY_PIN || '';
const paypalBase = process.env.NODE_ENV === 'test' && process.env.PAYPAL_API_BASE_URL
  ? process.env.PAYPAL_API_BASE_URL
  : 'https://api-m.sandbox.paypal.com';
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

function initialState() {
  return { inventory: structuredClone(seedInventory), orders: [], savedItems: 0, savedValueCents: 0 };
}

async function loadState() {
  if (remoteState) {
    const blob = await getBlob(stateBlobPath, { access: 'private', useCache: false, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blob) return initialState();
    stateEtag = blob.blob.etag.replace(/^W\//, '');
    return JSON.parse(await new Response(blob.stream).text());
  }
  try { return JSON.parse(await readFile(dataPath, 'utf8')); }
  catch { return initialState(); }
}
let state = await loadState();
let writeQueue = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    if (remoteState) {
      const saved = await putBlob(stateBlobPath, snapshot, {
        access: 'private', contentType: 'application/json', allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN,
        ...(stateEtag ? { ifMatch: stateEtag } : {})
      });
      stateEtag = saved.etag;
      return;
    }
    await mkdir(dirname(dataPath), { recursive: true });
    const temp = `${dataPath}.${randomUUID()}.tmp`;
    await writeFile(temp, snapshot);
    await rename(temp, dataPath);
  });
  return writeQueue;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function redirect(res, path) { res.writeHead(303, { Location: path }); res.end(); }
async function body(req) {
  let input = '';
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 16000) throw new HttpError(413, 'Request is too large.');
  }
  try { return JSON.parse(input || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function publicOrder(order) {
  const { paypalRequestIds, pickupCode, buyerToken, ...rest } = order;
  return rest;
}
function buyerOrder(order) {
  const { paypalRequestIds, ...rest } = order;
  return rest;
}
function getOrder(id) {
  const order = state.orders.find((entry) => entry.id === id);
  if (!order) throw new HttpError(404, 'Order not found.');
  return order;
}
function releaseStock(order) {
  for (const line of order.items) {
    const item = state.inventory.find((entry) => entry.id === line.id);
    if (item) item.quantity += 1;
  }
}
function assertState(order, expected) {
  if (order.status !== expected) throw new HttpError(409, `Order is ${order.status.replaceAll('_', ' ')}.`);
}
let tokenCache = { value: '', expiresAt: 0 };
async function paypalToken() {
  if (!paypalEnabled) throw new HttpError(503, 'PayPal sandbox credentials are not configured.');
  if (Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const result = await response.json();
  if (!response.ok) throw new HttpError(502, `PayPal authentication failed: ${result.error_description || result.error || response.status}`);
  tokenCache = { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
  return tokenCache.value;
}
async function paypal(path, { method = 'GET', data, requestId } = {}) {
  const headers = { Authorization: `Bearer ${await paypalToken()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetch(`${paypalBase}${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  const raw = await response.text();
  let result = {};
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw }; }
  if (!response.ok) {
    const detail = result.details?.[0]?.description || result.message || `HTTP ${response.status}`;
    throw new HttpError(502, `PayPal: ${detail}`);
  }
  return result;
}

const busyOrders = new Set();
const voiceInFlight = new Map();
async function withOrderLock(id, task) {
  if (busyOrders.has(id)) throw new HttpError(409, 'This order is already being updated.');
  busyOrders.add(id);
  try { return await task(); }
  finally { busyOrders.delete(id); }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, {
      inventory: state.inventory,
      orders: state.orders.map(publicOrder),
      savedItems: state.savedItems,
      savedValueCents: state.savedValueCents,
      pickupWindows,
      paymentMode: paypalEnabled ? 'paypal sandbox' : 'demo',
      voiceMode: process.env.VERCEL ? 'ElevenLabs static' : process.env.ELEVENLABS_API_KEY ? 'ElevenLabs' : 'browser',
      aiModel: process.env.VERCEL ? 'Xenova/all-MiniLM-L6-v2' : (process.env.OLLAMA_MODEL || 'qwen3-1.7b:latest')
    });
  }

  const voiceAction = url.pathname.match(/^\/api\/voice\/([a-z]+)$/);
  if (req.method === 'GET' && voiceAction) {
    const cue = voiceAction[1];
    const spokenText = voiceCues[cue];
    if (!spokenText) throw new HttpError(404, 'Voice cue not found.');
    if (!process.env.ELEVENLABS_API_KEY) return json(res, 503, { error: 'ElevenLabs is not configured.', text: spokenText });
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
    const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
    const fingerprint = createHash('sha256').update(`${cue}:${voiceId}:${modelId}:${spokenText}`).digest('hex').slice(0, 20);
    const audioPath = join(root, '.data', 'voice', `${fingerprint}.mp3`);
    let audio;
    try { audio = await readFile(audioPath); }
    catch {
      if (!voiceInFlight.has(audioPath)) {
        const job = elevenLabsSpeech(spokenText, { apiKey: process.env.ELEVENLABS_API_KEY, voiceId, modelId })
          .then(async (generated) => {
            await mkdir(dirname(audioPath), { recursive: true });
            await writeFile(audioPath, generated);
            return generated;
          })
          .finally(() => voiceInFlight.delete(audioPath));
        voiceInFlight.set(audioPath, job);
      }
      audio = await voiceInFlight.get(audioPath);
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'public, max-age=86400' });
    return res.end(audio);
  }

  if (req.method === 'POST' && url.pathname === '/api/match') {
    const input = await body(req);
    const request = String(input.request || '').trim().slice(0, 300);
    const budgetCents = Math.round(Number(input.budget) * 100);
    const allergens = Array.isArray(input.allergens) ? input.allergens.filter((x) => ['gluten', 'dairy', 'eggs', 'nuts'].includes(x)) : [];
    if (!request) throw new HttpError(400, 'Tell us what you are looking for.');
    if (!Number.isInteger(budgetCents) || budgetCents < 250 || budgetCents > 5000) throw new HttpError(400, 'Budget must be between $2.50 and $50.');
    const match = process.env.VERCEL
      ? await matchWithEmbeddings({ inventory: state.inventory, allergens, budgetCents, request })
      : await matchWithOllama({ inventory: state.inventory, allergens, budgetCents, request, model: process.env.OLLAMA_MODEL || 'qwen3-1.7b:latest', url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' });
    return json(res, 200, { ...match, totalCents: match.items.reduce((sum, item) => sum + item.priceCents, 0), budgetCents, allergens });
  }

  const inventoryAction = url.pathname.match(/^\/api\/inventory\/([a-z0-9]+)$/);
  if (req.method === 'PATCH' && inventoryAction) {
    if (paypalEnabled && (!bakeryPin || req.headers['x-bakery-pin'] !== bakeryPin)) throw new HttpError(403, 'Bakery PIN is required to edit stock.');
    const item = state.inventory.find((entry) => entry.id === inventoryAction[1]);
    if (!item) throw new HttpError(404, 'Item not found.');
    const input = await body(req);
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 50) throw new HttpError(400, 'Quantity must be a whole number from 0 to 50.');
    item.quantity = quantity;
    await persist();
    return json(res, 200, { item });
  }

  const buyerLookup = url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && buyerLookup) {
    const order = getOrder(buyerLookup[1]);
    if (url.searchParams.get('buyerToken') !== order.buyerToken) throw new HttpError(403, 'This order link is invalid.');
    return json(res, 200, { order: buyerOrder(order) });
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const input = await body(req);
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
    const allergens = Array.isArray(input.allergens) ? input.allergens.filter((x) => ['gluten', 'dairy', 'eggs', 'nuts'].includes(x)) : [];
    const budgetCents = Math.round(Number(input.budget) * 100);
    const pickupWindow = String(input.pickupWindow || '');
    if (!pickupWindows.includes(pickupWindow)) throw new HttpError(400, 'Choose a pickup window.');
    if (!Number.isInteger(budgetCents) || budgetCents < 250 || budgetCents > 5000) throw new HttpError(400, 'Invalid budget.');
    const items = normalizeSelection(ids, state.inventory, allergens, budgetCents);
    if (!items.length || items.length !== ids.length || ids.length > 3 || new Set(ids).size !== ids.length) throw new HttpError(409, 'Some items are no longer available or do not match your limits.');
    const id = randomUUID();
    const order = {
      id, createdAt: new Date().toISOString(), status: 'pending_payment', paymentMode: paypalEnabled ? 'paypal sandbox' : 'demo',
      items: items.map(({ id, name, priceCents, originalCents, icon }) => ({ id, name, priceCents, originalCents, icon })),
      totalCents: items.reduce((sum, item) => sum + item.priceCents, 0), pickupWindow,
      pickupCode: String(randomInt(100000, 1000000)),
      buyerToken: randomUUID(),
      paypalOrderId: null, authorizationId: null, captureId: null,
      paypalRequestIds: { create: randomUUID(), authorize: randomUUID(), capture: randomUUID(), void: randomUUID() }
    };
    for (const item of items) state.inventory.find((entry) => entry.id === item.id).quantity -= 1;
    state.orders.unshift(order);
    await persist();
    if (paypalEnabled) {
      try {
        const result = await paypal('/v2/checkout/orders', {
          method: 'POST', requestId: order.paypalRequestIds.create,
          data: {
            intent: 'AUTHORIZE',
            purchase_units: [{
              reference_id: id,
              custom_id: id,
              amount: {
                currency_code: 'USD', value: (order.totalCents / 100).toFixed(2),
                breakdown: { item_total: { currency_code: 'USD', value: (order.totalCents / 100).toFixed(2) } }
              },
              shipping: { type: 'PICKUP_IN_STORE' },
              items: order.items.map((item) => ({ name: item.name, quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'USD', value: (item.priceCents / 100).toFixed(2) } }))
            }],
            payment_source: { paypal: { experience_context: { return_url: `${baseUrl}/api/paypal/return?orderId=${id}&buyerToken=${order.buyerToken}`, cancel_url: `${baseUrl}/api/paypal/cancel?orderId=${id}&buyerToken=${order.buyerToken}`, user_action: 'PAY_NOW' } } }
          }
        });
        const approvalUrl = result.links?.find((link) => ['payer-action', 'approve'].includes(link.rel))?.href;
        if (!result.id || !approvalUrl) throw new Error('PayPal did not return an approval link.');
        order.paypalOrderId = result.id;
        await persist();
        return json(res, 201, { order: buyerOrder(order), approvalUrl });
      } catch (error) {
        // An uncertain provider response is left visible for review rather than retried automatically.
        order.status = 'payment_error';
        order.error = error.message;
        releaseStock(order);
        await persist();
        throw error;
      }
    }
    return json(res, 201, { order: buyerOrder(order), demoApproval: true });
  }

  const orderAction = url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)\/(demo-approve|capture|cancel)$/);
  if (req.method === 'POST' && orderAction) {
    const [, id, action] = orderAction;
    return withOrderLock(id, async () => {
      const order = getOrder(id);
      if (action === 'demo-approve') {
        if (order.paymentMode !== 'demo') throw new HttpError(400, 'Demo approval is unavailable for PayPal orders.');
        if (req.headers['x-buyer-token'] !== order.buyerToken) throw new HttpError(403, 'This order link is invalid.');
        assertState(order, 'pending_payment');
        order.authorizationId = `DEMO-${id.slice(0, 8)}`;
        order.status = 'authorized';
        await persist();
        return json(res, 200, { order: buyerOrder(order) });
      }
      if (order.paymentMode === 'paypal sandbox' && (!bakeryPin || req.headers['x-bakery-pin'] !== bakeryPin)) throw new HttpError(403, 'Bakery PIN is required for sandbox payment actions.');
      if (action === 'capture') {
        const input = await body(req);
        assertState(order, 'authorized');
        if (String(input.pickupCode || '') !== order.pickupCode) throw new HttpError(403, 'Pickup code does not match.');
        if (order.paymentMode === 'paypal sandbox') {
          const result = await paypal(`/v2/payments/authorizations/${encodeURIComponent(order.authorizationId)}/capture`, {
            method: 'POST', requestId: order.paypalRequestIds.capture, data: { final_capture: true, amount: { currency_code: 'USD', value: (order.totalCents / 100).toFixed(2) } }
          });
          order.captureId = result.id;
          order.status = result.status === 'COMPLETED' ? 'completed' : 'capture_pending';
        } else {
          order.captureId = `DEMO-${id.slice(0, 8)}`;
          order.status = 'completed';
        }
        if (order.status === 'completed') {
          state.savedItems += order.items.length;
          state.savedValueCents += order.items.reduce((sum, item) => sum + item.originalCents, 0);
        }
        await persist();
        return json(res, 200, { order: publicOrder(order) });
      }
      if (action === 'cancel') {
        if (!['pending_payment', 'authorized'].includes(order.status)) throw new HttpError(409, 'This order cannot be cancelled.');
        if (order.paymentMode === 'paypal sandbox' && order.status === 'authorized') {
          await paypal(`/v2/payments/authorizations/${encodeURIComponent(order.authorizationId)}/void`, { method: 'POST', requestId: order.paypalRequestIds.void });
        }
        order.status = 'cancelled';
        releaseStock(order);
        await persist();
        return json(res, 200, { order: publicOrder(order) });
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/paypal/return') {
    const order = getOrder(url.searchParams.get('orderId'));
    return withOrderLock(order.id, async () => {
      if (url.searchParams.get('buyerToken') !== order.buyerToken) throw new HttpError(403, 'This order link is invalid.');
      if (order.paymentMode !== 'paypal sandbox') throw new HttpError(400, 'This is a demo order.');
      if (order.status === 'authorized') return redirect(res, `/?order=${order.id}&buyerToken=${order.buyerToken}&payment=approved`);
      assertState(order, 'pending_payment');
      if (url.searchParams.get('token') !== order.paypalOrderId) throw new HttpError(400, 'PayPal order does not match.');
      const result = await paypal(`/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId)}/authorize`, { method: 'POST', requestId: order.paypalRequestIds.authorize, data: {} });
      const authorization = result.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!authorization?.id) throw new HttpError(502, 'PayPal did not return an authorization.');
      order.authorizationId = authorization.id;
      order.status = 'authorized';
      await persist();
      return redirect(res, `/?order=${order.id}&buyerToken=${order.buyerToken}&payment=approved`);
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/paypal/cancel') {
    const order = getOrder(url.searchParams.get('orderId'));
    return withOrderLock(order.id, async () => {
      if (url.searchParams.get('buyerToken') !== order.buyerToken) throw new HttpError(403, 'This order link is invalid.');
      if (order.status === 'pending_payment') {
        order.status = 'cancelled';
        releaseStock(order);
        await persist();
      }
      return redirect(res, '/?payment=cancelled');
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
    if (paypalEnabled) throw new HttpError(403, 'Reset is available only in demo mode.');
    state = initialState();
    await persist();
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Page not found.');
}

let apiQueue = Promise.resolve();
async function queuedApi(req, res, url) {
  const previous = apiQueue;
  let release;
  apiQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    if (remoteState) state = await loadState();
    return await handleApi(req, res, url);
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, baseUrl);
    if (staticFiles.has(url.pathname) && req.method === 'GET') {
      const [file, type] = staticFiles.get(url.pathname);
      const content = await readFile(join(root, 'public', file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(content);
    }
    return url.pathname.startsWith('/api/voice/')
      ? await handleApi(req, res, url)
      : await queuedApi(req, res, url);
  } catch (error) {
    if (!res.headersSent) json(res, error instanceof BlobPreconditionFailedError ? 409 : error.status || 500, { error: error instanceof BlobPreconditionFailedError ? 'Another order changed. Refresh and try again.' : error.message || 'Unexpected server error.' });
    else res.end();
  }
});
server.listen(port, () => console.log(`LastCall ready at ${baseUrl} (${paypalEnabled ? 'PayPal sandbox' : 'demo payments'})`));
