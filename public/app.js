const $ = (selector) => document.querySelector(selector);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let appState = null;
let selectedMatch = null;
let currentOrder = null;
let activeView = 'shop';
let toastTimer;
let playingAudio = null;
let audioUrl = null;
let speaking = false;
let voiceRequest = 0;
const browserVoiceText = {
  welcome: 'Welcome to LastCall. Tell us what you are craving, set your budget, and we will build a rescue bag from tonight’s fresh bakes.',
  matched: 'Your rescue bag is ready. Every item was checked against your budget and the ingredients you asked us to leave out.',
  reserved: 'Your bag is reserved. Approve the test payment to reveal your pickup code.',
  pickup: 'You are all set. Show your six digit code at the bakery counter. Payment is captured only when you pick up your food.',
  completed: 'Rescued and ready to enjoy. Thanks for giving good food a second chance.',
  counter: 'Welcome to the bakery counter. Update what is left, then confirm each pickup with the customer’s code.'
};

function voiceCue() {
  if (activeView === 'bakery') return 'counter';
  if (currentOrder?.status === 'completed') return 'completed';
  if (currentOrder?.status === 'authorized') return 'pickup';
  if (currentOrder?.status === 'pending_payment') return 'reserved';
  if (selectedMatch?.items?.length) return 'matched';
  return 'welcome';
}
function stopVoice() {
  voiceRequest++;
  if (playingAudio) { playingAudio.pause(); playingAudio = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speaking = false;
  $('#voiceButton').setAttribute('aria-pressed', 'false');
  $('#voiceButton').setAttribute('aria-label', 'Play voice guide');
  $('#voiceButton .voice-label').textContent = 'Listen';
}
function browserSpeak(text) {
  if (!('speechSynthesis' in window)) { toast('Voice playback is not available in this browser.', true); stopVoice(); return; }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US'; utterance.rate = 0.94; utterance.pitch = 0.98;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => /Jenny|Aria|Samantha/i.test(voice.name) && voice.lang.startsWith('en')) || voices.find((voice) => voice.lang.startsWith('en')) || null;
  utterance.onend = stopVoice;
  utterance.onerror = stopVoice;
  speechSynthesis.speak(utterance);
}
async function playVoice() {
  if (speaking) { stopVoice(); return; }
  speaking = true;
  const requestId = ++voiceRequest;
  $('#voiceButton').setAttribute('aria-pressed', 'true');
  $('#voiceButton').setAttribute('aria-label', 'Stop voice guide');
  $('#voiceButton .voice-label').textContent = 'Loading voice…';
  const cue = voiceCue();
  try {
    const voiceUrl = appState?.voiceMode === 'ElevenLabs static' ? `/voice/${cue}.mp3` : `/api/voice/${cue}`;
    const response = await fetch(voiceUrl);
    if (!speaking || requestId !== voiceRequest) return;
    if (!response.ok) {
      $('#voiceButton .voice-label').textContent = 'Stop voice';
      browserSpeak(browserVoiceText[cue]);
      return;
    }
    const audioBlob = await response.blob();
    if (!speaking || requestId !== voiceRequest) return;
    audioUrl = URL.createObjectURL(audioBlob);
    playingAudio = new Audio(audioUrl);
    playingAudio.onended = stopVoice;
    playingAudio.onerror = () => { stopVoice(); toast('Could not play voice audio.', true); };
    $('#voiceButton .voice-label').textContent = 'Stop voice';
    await playingAudio.play();
  } catch {
    if (!speaking || requestId !== voiceRequest) return;
    $('#voiceButton .voice-label').textContent = 'Stop voice';
    browserSpeak(browserVoiceText[cue]);
  }
}
function celebratePickup() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const overlay = document.createElement('div');
  overlay.className = 'celebrate';
  const colors = ['#ef7561', '#ffd787', '#8eb9a3', '#bda0c8', '#e8a974'];
  for (let i = 0; i < 22; i++) {
    const piece = document.createElement('span');
    piece.style.setProperty('--confetti', colors[i % colors.length]);
    piece.style.setProperty('--tx', `${Math.round((Math.random() - .5) * 650)}px`);
    piece.style.setProperty('--ty', `${Math.round((Math.random() - .4) * 430)}px`);
    piece.style.setProperty('--rot', `${Math.round((Math.random() - .5) * 1000)}deg`);
    piece.style.setProperty('--delay', `${Math.round(Math.random() * 150)}ms`);
    overlay.append(piece);
  }
  document.body.append(overlay);
  setTimeout(() => overlay.remove(), 1700);
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 4300);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function inputs() {
  return {
    request: $('#requestInput').value.trim(),
    budget: Number($('#budgetInput').value),
    allergens: [...document.querySelectorAll('.allergy-options input:checked')].map((input) => input.value),
    pickupWindow: $('#pickupInput').value
  };
}
function setView(view) {
  activeView = view;
  $('#shopView').hidden = view !== 'shop';
  $('#bakeryView').hidden = view !== 'bakery';
  $('#shopTab').classList.toggle('active', view === 'shop');
  $('#bakeryTab').classList.toggle('active', view === 'bakery');
  $('#shopTab').setAttribute('aria-current', view === 'shop' ? 'page' : 'false');
  $('#bakeryTab').setAttribute('aria-current', view === 'bakery' ? 'page' : 'false');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderInventory() {
  const available = appState.inventory.reduce((sum, item) => sum + item.quantity, 0);
  $('#itemTotal').textContent = `${available} treats left today`;
  $('#inventoryGrid').innerHTML = appState.inventory.map((item) => `
    <article class="inventory-card">
      <div class="inventory-art ${esc(item.color)}" aria-hidden="true">${esc(item.icon)}</div>
      <div class="inventory-info">
        <span class="inventory-category">${esc(item.category)}</span>
        <h3>${esc(item.name)}</h3>
        <p>${esc(item.description)}</p>
        <div class="inventory-bottom"><div><strong>${money(item.priceCents)}</strong><del>${money(item.originalCents)}</del></div><span>${item.quantity ? `${item.quantity} left` : 'Sold out'}</span></div>
      </div>
    </article>`).join('');
}
function renderStats() {
  const reserved = appState.orders.filter((order) => order.status === 'authorized').reduce((sum, order) => sum + order.items.length, 0);
  $('#statAvailable').textContent = appState.inventory.reduce((sum, item) => sum + item.quantity, 0);
  $('#statReserved').textContent = reserved;
  $('#statSaved').textContent = appState.savedItems;
  $('#statValue').textContent = money(appState.savedValueCents);
  $('#orderCount').textContent = appState.orders.filter((order) => order.status === 'authorized').length;
  $('#modePill').textContent = appState.paymentMode === 'paypal sandbox' ? 'PayPal sandbox connected' : 'Demo payments';
  $('#resetButton').hidden = appState.paymentMode !== 'demo';
  $('#bakeryPinField').hidden = appState.paymentMode !== 'paypal sandbox';
}
function renderOrders() {
  const list = $('#ordersList');
  if (!appState.orders.length) {
    list.innerHTML = '<div class="empty-orders"><strong>Nothing to hand over yet.</strong>New orders will appear here as soon as a buyer reserves a bundle.</div>';
    return;
  }
  list.innerHTML = appState.orders.map((order) => `
    <article class="order-card" data-order-id="${esc(order.id)}">
      <div>
        <span class="order-id">ORDER ${esc(order.id.slice(0, 8).toUpperCase())} · ${esc(order.paymentMode)}</span>
        <h3>${order.items.map((item) => esc(item.name)).join(' + ')}</h3>
        <p>${esc(order.pickupWindow)} · ${money(order.totalCents)} · <span class="status-chip ${esc(order.status)}">${esc(order.status.replaceAll('_', ' '))}</span></p>
        ${order.paypalOrderId ? `<p>PayPal order: ${esc(order.paypalOrderId)}${order.captureId ? ` · Capture: ${esc(order.captureId)}` : ''}</p>` : ''}
      </div>
      <div class="order-actions">
        ${order.status === 'authorized' ? `<input aria-label="Pickup code for order ${esc(order.id.slice(0, 8))}" class="code-input" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button class="primary-button capture-button" type="button">Confirm pickup</button><button class="secondary-button cancel-button" type="button">Cancel</button>` : ''}
        ${order.status === 'pending_payment' ? `<button class="secondary-button cancel-button" type="button">Cancel reservation</button>` : ''}
      </div>
    </article>`).join('');
}
function renderStock() {
  $('#stockList').innerHTML = appState.inventory.map((item) => `
    <div class="stock-row" data-item-id="${esc(item.id)}">
      <span class="stock-icon">${esc(item.icon)}</span>
      <span class="stock-name">${esc(item.name)}<small>${esc(item.category)} · ${money(item.priceCents)}</small></span>
      <label>Available <input class="stock-input" aria-label="Available ${esc(item.name)}" type="number" min="0" max="50" step="1" value="${item.quantity}"></label>
      <button type="button" class="secondary-button stock-save">Save</button>
    </div>`).join('');
}
function renderBundle() {
  const panel = $('#bundlePanel');
  if (currentOrder) {
    const statusText = {
      pending_payment: 'Ready for payment approval',
      authorized: 'Reserved for pickup',
      completed: 'Picked up and paid',
      capture_pending: 'Payment capture pending',
      cancelled: 'Reservation cancelled',
      payment_error: 'Payment needs review'
    }[currentOrder.status] || currentOrder.status;
    panel.innerHTML = `<div class="bundle-result">
      <div class="bundle-topline"><span class="bundle-tag">${esc(statusText)}</span><span>✳</span></div>
      <h3>Your good thing is waiting.</h3>
      <p class="bundle-reason">Pickup at Maple &amp; Rye, ${esc(currentOrder.pickupWindow)}.</p>
      ${currentOrder.items.map((item) => `<div class="bundle-item"><span class="bundle-item-icon">${esc(item.icon)}</span><span class="bundle-item-name">${esc(item.name)}</span><span class="bundle-item-price">${money(item.priceCents)}</span></div>`).join('')}
      <div class="bundle-total"><span>Total</span><strong>${money(currentOrder.totalCents)}</strong></div>
      ${currentOrder.status === 'pending_payment' && currentOrder.paymentMode === 'demo' ? '<div class="bundle-actions"><button class="primary-button" id="approveDemoButton" type="button">Approve demo payment <span>↗</span></button><p class="payment-note">Simulated authorization — no money moves.</p></div>' : ''}
      ${currentOrder.status === 'authorized' ? `<div class="order-ticket"><h4>Show this code at pickup</h4><div class="pickup-code">${esc(currentOrder.pickupCode)}</div><p>The bakery uses it to confirm pickup and capture the payment.</p>${currentOrder.authorizationId ? `<p>Authorization: ${esc(currentOrder.authorizationId)}</p>` : ''}</div>` : ''}
      ${currentOrder.status === 'completed' ? `<div class="order-ticket"><h4>Rescued and ready to enjoy</h4><p>Pickup is complete. ${currentOrder.paymentMode === 'demo' ? 'Demo payment was simulated.' : `PayPal capture ${esc(currentOrder.captureId || '')} is complete.`}</p></div>` : ''}
    </div>`;
    return;
  }
  if (!selectedMatch) {
    panel.innerHTML = '<div class="bundle-empty"><div class="bundle-empty-art">✳</div><h3>A bag with your name on it.</h3><p>Share what you’re craving and we’ll find a fit from today’s bakes.</p><div class="curved-arrow">↖</div></div>';
    return;
  }
  if (!selectedMatch.items.length) {
    panel.innerHTML = '<div class="bundle-empty"><div class="bundle-empty-art">✳</div><h3>Nothing fits just yet.</h3><p>Try a bigger budget or fewer exclusions to see what is left today.</p></div>';
    return;
  }
  panel.innerHTML = `<div class="bundle-result">
    <div class="bundle-topline"><span class="bundle-tag">Matched with ${esc(selectedMatch.source)}</span><span>✳</span></div>
    <h3>Your little rescue bag.</h3><p class="bundle-reason">${esc(selectedMatch.reason)}</p>
    ${selectedMatch.items.map((item) => `<div class="bundle-item"><span class="bundle-item-icon">${esc(item.icon)}</span><span class="bundle-item-name">${esc(item.name)}<small>${esc(item.category)}</small></span><span class="bundle-item-price">${money(item.priceCents)}</span></div>`).join('')}
    <div class="bundle-total"><span>Today’s total</span><strong>${money(selectedMatch.totalCents)}</strong></div>
    <div class="bundle-actions"><button class="primary-button" id="reserveButton" type="button">${appState.paymentMode === 'demo' ? 'Reserve with demo payment' : 'Reserve with PayPal'} <span>↗</span></button><p class="payment-note">${appState.paymentMode === 'demo' ? 'Demo mode simulates a PayPal authorization until credentials are added.' : 'PayPal sandbox uses test money only. Payment is captured after pickup.'}</p></div>
  </div>`;
}
async function refresh() {
  appState = await api('/api/state');
  $('#pickupInput').innerHTML = appState.pickupWindows.map((window) => `<option>${esc(window)}</option>`).join('');
  renderInventory(); renderStats(); renderOrders(); renderStock();
  if (currentOrder?.buyerToken) {
    const result = await api(`/api/orders/${currentOrder.id}?buyerToken=${encodeURIComponent(currentOrder.buyerToken)}`);
    currentOrder = result.order;
  }
  renderBundle();
}

$('#shopTab').addEventListener('click', () => setView('shop'));
$('#bakeryTab').addEventListener('click', () => setView('bakery'));
$('#voiceButton').addEventListener('click', playVoice);
$('#refreshButton').addEventListener('click', async () => { try { await refresh(); toast('Orders refreshed.'); } catch (error) { toast(error.message, true); } });
$('#matchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#matchButton');
  const input = inputs();
  button.disabled = true; button.innerHTML = 'Finding your bundle… <span aria-hidden="true">✳</span>';
  $('#bundlePanel').innerHTML = '<div class="bundle-empty"><div class="bundle-empty-art">✳</div><h3>Looking through the case…</h3><p>Matching your request to what is fresh tonight.</p></div>';
  try {
    selectedMatch = await api('/api/match', { method: 'POST', body: JSON.stringify(input) });
    currentOrder = null;
    renderBundle();
    if (selectedMatch.source === 'rules fallback') toast('The local model was unavailable; a safe rules-based match is shown.');
  } catch (error) { selectedMatch = null; renderBundle(); toast(error.message, true); }
  finally { button.disabled = false; button.innerHTML = 'Find my bundle <span aria-hidden="true">↗</span>'; }
});
$('#bundlePanel').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'reserveButton') {
    button.disabled = true; button.textContent = 'Reserving…';
    try {
      const input = inputs();
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify({ ids: selectedMatch.items.map((item) => item.id), budget: input.budget, allergens: input.allergens, pickupWindow: input.pickupWindow }) });
      currentOrder = result.order;
      localStorage.setItem('lastcallBuyerOrder', JSON.stringify({ id: currentOrder.id, buyerToken: currentOrder.buyerToken }));
      await refresh();
      if (result.approvalUrl) window.location.assign(result.approvalUrl);
      else toast('Bundle reserved. Approve the demo payment to get your pickup code.');
    } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'Try reservation again'; }
  }
  if (button.id === 'approveDemoButton') {
    button.disabled = true;
    try {
      const result = await api(`/api/orders/${currentOrder.id}/demo-approve`, { method: 'POST', headers: { 'X-Buyer-Token': currentOrder.buyerToken } });
      currentOrder = result.order; await refresh(); toast('Demo payment approved. Your pickup code is ready.');
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }
});
$('#ordersList').addEventListener('click', async (event) => {
  const card = event.target.closest('.order-card');
  const button = event.target.closest('button');
  if (!card || !button) return;
  const id = card.dataset.orderId;
  button.disabled = true;
  try {
    if (button.classList.contains('capture-button')) {
      const pickupCode = card.querySelector('.code-input').value.trim();
      if (!pickupCode) throw new Error('Enter the buyer’s six-digit pickup code.');
      await api(`/api/orders/${id}/capture`, { method: 'POST', headers: { 'X-Bakery-Pin': $('#bakeryPinInput').value }, body: JSON.stringify({ pickupCode }) });
      toast('Pickup confirmed. Payment captured.');
      celebratePickup();
    } else if (button.classList.contains('cancel-button')) {
      await api(`/api/orders/${id}/cancel`, { method: 'POST', headers: { 'X-Bakery-Pin': $('#bakeryPinInput').value }, body: '{}' });
      toast('Reservation cancelled and items returned to the shelf.');
    }
    await refresh();
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$('#stockList').addEventListener('click', async (event) => {
  const button = event.target.closest('.stock-save');
  if (!button) return;
  const row = button.closest('.stock-row');
  const id = row.dataset.itemId;
  const quantity = Number(row.querySelector('.stock-input').value);
  button.disabled = true;
  try {
    await api(`/api/inventory/${id}`, { method: 'PATCH', headers: { 'X-Bakery-Pin': $('#bakeryPinInput').value }, body: JSON.stringify({ quantity }) });
    await refresh();
    toast('Shelf quantity updated.');
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$('#resetButton').addEventListener('click', async () => {
  try { await api('/api/demo/reset', { method: 'POST', body: '{}' }); currentOrder = null; selectedMatch = null; localStorage.removeItem('lastcallBuyerOrder'); await refresh(); toast('Demo reset.'); }
  catch (error) { toast(error.message, true); }
});

try {
  await refresh();
  const params = new URLSearchParams(location.search);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('lastcallBuyerOrder') || 'null'); } catch {}
  const buyerLink = params.has('order') ? { id: params.get('order'), buyerToken: params.get('buyerToken') } : saved;
  if (buyerLink?.id && buyerLink?.buyerToken) {
    try {
      const result = await api(`/api/orders/${buyerLink.id}?buyerToken=${encodeURIComponent(buyerLink.buyerToken)}`);
      currentOrder = result.order;
      localStorage.setItem('lastcallBuyerOrder', JSON.stringify(buyerLink));
      renderBundle();
    } catch { localStorage.removeItem('lastcallBuyerOrder'); }
  }
  if (params.get('payment') === 'approved') toast('PayPal approved the payment. Show your pickup code at the bakery.');
  if (params.get('payment') === 'cancelled') toast('PayPal checkout was cancelled.');
  if (params.has('payment')) history.replaceState({}, '', '/');
} catch (error) { toast(error.message, true); }
