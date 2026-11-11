import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSelection, coverRequestedCourses } from '../matching.mjs';
import { seedInventory } from '../catalog.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function request(base, path, { method = 'GET', data, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { status: response.status, data: await response.json() };
}

test('bundle rules enforce allergens, budget and requested courses', () => {
  const items = normalizeSelection(['c6', 'c7', 'c3', 'c4'], seedInventory, ['nuts'], 1000);
  assert.deepEqual(items.map((item) => item.id), ['c7', 'c3']);
  const covered = coverRequestedCourses([seedInventory[2]], seedInventory, ['nuts'], 1500, 'savory dinner and sweet treat');
  assert.ok(covered.some((item) => item.category === 'Savory'));
  assert.ok(covered.some((item) => item.category === 'Sweet'));
  assert.ok(covered.every((item) => !item.allergens.includes('nuts')));
});

test('reservation, buyer approval, pickup capture and cancellation', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataPath = join(root, '.data', `test-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DATA_PATH: dataPath, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', OLLAMA_URL: 'http://127.0.0.1:1' },
    stdio: 'ignore'
  });
  t.after(async () => { child.kill(); try { await unlink(dataPath); } catch {} });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch(`${base}/api/state`); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'test server started');
  const state = (await request(base, '/api/state')).data;
  const match = await request(base, '/api/match', { method: 'POST', data: { request: 'savory dinner and sweet treat', budget: 15, allergens: ['nuts'] } });
  assert.equal(match.status, 200);
  assert.ok(match.data.items.some((item) => item.category === 'Savory'));
  assert.ok(match.data.items.some((item) => item.category === 'Sweet'));
  const orderInput = { ids: match.data.items.map((item) => item.id), budget: 15, allergens: ['nuts'], pickupWindow: state.pickupWindows[0] };
  const created = await request(base, '/api/orders', { method: 'POST', data: orderInput });
  assert.equal(created.status, 201);
  assert.equal(created.data.order.status, 'pending_payment');
  const { id, buyerToken } = created.data.order;
  assert.ok(buyerToken);
  const publicState = (await request(base, '/api/state')).data;
  assert.equal(publicState.orders[0].pickupCode, undefined);
  assert.equal(publicState.orders[0].buyerToken, undefined);
  assert.equal((await request(base, `/api/orders/${id}?buyerToken=wrong`)).status, 403);
  const approved = await request(base, `/api/orders/${id}/demo-approve`, { method: 'POST', data: {}, headers: { 'X-Buyer-Token': buyerToken } });
  assert.equal(approved.data.order.status, 'authorized');
  const badCode = await request(base, `/api/orders/${id}/capture`, { method: 'POST', data: { pickupCode: '000000' } });
  assert.equal(badCode.status, 403);
  const captured = await request(base, `/api/orders/${id}/capture`, { method: 'POST', data: { pickupCode: approved.data.order.pickupCode } });
  assert.equal(captured.data.order.status, 'completed');
  assert.equal((await request(base, `/api/orders/${id}/capture`, { method: 'POST', data: { pickupCode: approved.data.order.pickupCode } })).status, 409);
  const afterCapture = (await request(base, '/api/state')).data;
  assert.equal(afterCapture.savedItems, created.data.order.items.length);

  const second = await request(base, '/api/orders', { method: 'POST', data: { ids: ['c1'], budget: 10, allergens: [], pickupWindow: state.pickupWindows[1] } });
  assert.equal(second.status, 201);
  const cancelled = await request(base, `/api/orders/${second.data.order.id}/cancel`, { method: 'POST', data: {} });
  assert.equal(cancelled.data.order.status, 'cancelled');
  const afterCancel = (await request(base, '/api/state')).data;
  assert.equal(afterCancel.inventory.find((item) => item.id === 'c1').quantity, state.inventory.find((item) => item.id === 'c1').quantity);
  const edited = await request(base, '/api/inventory/c1', { method: 'PATCH', data: { quantity: 2 } });
  assert.equal(edited.status, 200);
  assert.equal((await request(base, '/api/state')).data.inventory.find((item) => item.id === 'c1').quantity, 2);
});

test('PayPal sandbox branch authorizes, captures and voids through the provider API', async (t) => {
  const providerCalls = [];
  let orderNumber = 0;
  const provider = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    providerCalls.push({ path: req.url, method: req.method, requestId: req.headers['paypal-request-id'], payload });
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/oauth2/token') return reply(200, { access_token: 'mock-token', expires_in: 3600 });
    if (req.url === '/v2/checkout/orders' && req.method === 'POST') {
      orderNumber++;
      return reply(201, { id: `MOCKORDER${orderNumber}`, links: [{ rel: 'payer-action', href: 'https://example.test/approve' }] });
    }
    if (/^\/v2\/checkout\/orders\/MOCKORDER\d+\/authorize$/.test(req.url)) return reply(201, { purchase_units: [{ payments: { authorizations: [{ id: `AUTH${req.url.match(/\d+/)[0]}`, status: 'CREATED' }] } }] });
    if (/^\/v2\/payments\/authorizations\/AUTH\d+\/capture$/.test(req.url)) return reply(201, { id: 'CAPTURE1', status: 'COMPLETED' });
    if (/^\/v2\/payments\/authorizations\/AUTH\d+\/void$/.test(req.url)) return reply(204, {});
    return reply(404, { message: 'Unknown mock provider path' });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataPath = join(root, '.data', `test-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), PUBLIC_BASE_URL: base, DATA_PATH: dataPath, PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret', BAKERY_PIN: '123456', PAYPAL_API_BASE_URL: providerBase },
    stdio: 'ignore'
  });
  t.after(async () => { child.kill(); await new Promise((resolve) => provider.close(resolve)); try { await unlink(dataPath); } catch {} });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch(`${base}/api/state`); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'PayPal branch server started');
  const state = (await request(base, '/api/state')).data;
  assert.equal(state.paymentMode, 'paypal sandbox');
  assert.equal((await request(base, '/api/inventory/c1', { method: 'PATCH', data: { quantity: 2 } })).status, 403);
  const makeOrder = async (itemId) => {
    const created = await request(base, '/api/orders', { method: 'POST', data: { ids: [itemId], budget: 10, allergens: [], pickupWindow: state.pickupWindows[0] } });
    assert.equal(created.status, 201);
    assert.equal(created.data.approvalUrl, 'https://example.test/approve');
    const order = created.data.order;
    const returnUrl = `${base}/api/paypal/return?orderId=${order.id}&buyerToken=${order.buyerToken}&token=${order.paypalOrderId}`;
    const approved = await fetch(returnUrl, { redirect: 'manual' });
    assert.equal(approved.status, 303);
    assert.match(approved.headers.get('location'), /payment=approved/);
    return (await request(base, `/api/orders/${order.id}?buyerToken=${order.buyerToken}`)).data.order;
  };
  const first = await makeOrder('c1');
  assert.equal(first.status, 'authorized');
  const denied = await request(base, `/api/orders/${first.id}/capture`, { method: 'POST', data: { pickupCode: first.pickupCode }, headers: { 'X-Bakery-Pin': 'wrong' } });
  assert.equal(denied.status, 403);
  const captured = await request(base, `/api/orders/${first.id}/capture`, { method: 'POST', data: { pickupCode: first.pickupCode }, headers: { 'X-Bakery-Pin': '123456' } });
  assert.equal(captured.data.order.status, 'completed');
  assert.equal(captured.data.order.captureId, 'CAPTURE1');
  const second = await makeOrder('c2');
  const voided = await request(base, `/api/orders/${second.id}/cancel`, { method: 'POST', data: {}, headers: { 'X-Bakery-Pin': '123456' } });
  assert.equal(voided.data.order.status, 'cancelled');
  assert.ok(providerCalls.some((call) => call.path.endsWith('/capture') && call.requestId));
  assert.ok(providerCalls.some((call) => call.path.endsWith('/void') && call.requestId));
  const createCall = providerCalls.find((call) => call.path === '/v2/checkout/orders');
  assert.equal(JSON.parse(createCall.payload).intent, 'AUTHORIZE');
  assert.equal(JSON.parse(createCall.payload).purchase_units[0].shipping.type, 'PICKUP_IN_STORE');
});
