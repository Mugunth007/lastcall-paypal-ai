export function safeCandidates(inventory, allergens, budgetCents) {
  const blocked = new Set(allergens.map((value) => value.toLowerCase()));
  return inventory.filter((item) =>
    item.quantity > 0 &&
    item.priceCents <= budgetCents &&
    !item.allergens.some((allergen) => blocked.has(allergen))
  );
}

export function normalizeSelection(ids, inventory, allergens, budgetCents) {
  const candidates = safeCandidates(inventory, allergens, budgetCents);
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const selected = [];
  let total = 0;
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || selected.some((existing) => existing.id === id)) continue;
    if (total + item.priceCents > budgetCents) continue;
    selected.push(item);
    total += item.priceCents;
    if (selected.length >= 3) break;
  }
  return selected;
}

export function fallbackMatch(inventory, allergens, budgetCents, request) {
  const words = request.toLowerCase();
  const candidates = safeCandidates(inventory, allergens, budgetCents)
    .map((item) => {
      let score = Math.round(((item.originalCents - item.priceCents) / item.originalCents) * 10);
      if (/dinner|lunch|savou?r|meal|hungry/.test(words) && item.category === 'Savory') score += 9;
      if (/breakfast|morning/.test(words) && ['Pastry', 'Bread'].includes(item.category)) score += 8;
      if (/sweet|dessert|treat|cake/.test(words) && item.category === 'Sweet') score += 8;
      if (words.includes(item.name.toLowerCase().split(' ')[0])) score += 10;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.priceCents - b.item.priceCents)
    .map((entry) => entry.item);
  return normalizeSelection(candidates.map((item) => item.id), inventory, allergens, budgetCents);
}

export function coverRequestedCourses(items, inventory, allergens, budgetCents, request) {
  const words = request.toLowerCase();
  const wanted = [];
  if (/dinner|lunch|savou?r|meal|hungry/.test(words)) wanted.push('Savory');
  if (/sweet|dessert|treat|cake/.test(words)) wanted.push('Sweet');
  let result = [...items];
  for (const category of wanted) {
    if (result.some((item) => item.category === category)) continue;
    const candidate = safeCandidates(inventory, allergens, budgetCents)
      .filter((item) => item.category === category && !result.some((chosen) => chosen.id === item.id))
      .sort((a, b) => a.priceCents - b.priceCents)[0];
    if (!candidate) continue;
    while (result.length && (result.length >= 3 || result.reduce((sum, item) => sum + item.priceCents, candidate.priceCents) > budgetCents)) {
      const removable = result.findIndex((item) => !wanted.includes(item.category) || result.filter((other) => other.category === item.category).length > 1);
      result.splice(removable >= 0 ? removable : result.length - 1, 1);
    }
    if (result.reduce((sum, item) => sum + item.priceCents, candidate.priceCents) <= budgetCents) result.push(candidate);
  }
  return result.slice(0, 3).sort((a, b) => {
    if (wanted.includes('Savory')) return (a.category === 'Savory' ? -1 : b.category === 'Savory' ? 1 : 0);
    return 0;
  });
}

function describeMatch(items) {
  const savory = items.find((item) => item.category === 'Savory');
  const sweet = items.find((item) => item.category === 'Sweet');
  if (savory && sweet) return `${savory.name} for a savory bite, ${sweet.name} for something sweet — all within your budget.`;
  return `${items.map((item) => item.name).join(' and ')} from today’s bake, checked against your limits.`;
}

export async function matchWithOllama({ inventory, allergens, budgetCents, request, model, url }) {
  const candidates = safeCandidates(inventory, allergens, budgetCents);
  if (!candidates.length) return { items: [], reason: 'Nothing in today’s case meets those needs.', source: 'rules' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        think: false,
        options: { temperature: 0, num_predict: 300 },
        messages: [
          { role: 'system', content: 'You match a bakery customer to food. Return ONLY JSON {"ids":["id"],"reason":"one short friendly sentence"}. Pick 2 or 3 different items from the provided list. If the customer wants savory dinner and a sweet treat, include at least one Savory and one Sweet. Never invent an ID. Never discuss food safety. Allergens and budget are checked by the server.' },
          { role: 'user', content: JSON.stringify({ request, budgetUSD: (budgetCents / 100).toFixed(2), excludedAllergens: allergens, available: candidates.map(({ id, name, category, description, priceCents }) => ({ id, name, category, description, priceUSD: (priceCents / 100).toFixed(2) })) }) }
        ]
      })
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const result = await response.json();
    const parsed = JSON.parse(result.message?.content || '{}');
    const items = coverRequestedCourses(normalizeSelection(Array.isArray(parsed.ids) ? parsed.ids : [], inventory, allergens, budgetCents), inventory, allergens, budgetCents, request);
    if (!items.length) throw new Error('Model selected no valid items');
    return {
      items,
      reason: describeMatch(items),
      source: 'local AI'
    };
  } catch {
    return { items: coverRequestedCourses(fallbackMatch(inventory, allergens, budgetCents, request), inventory, allergens, budgetCents, request), reason: 'A fresh selection from today’s case that fits your limits.', source: 'rules fallback' };
  } finally {
    clearTimeout(timeout);
  }
}

let embeddingPipeline;
async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    embeddingPipeline = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.VERCEL ? '/tmp/lastcall-model-cache' : '.data/model-cache';
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    })().catch((error) => { embeddingPipeline = null; throw error; });
  }
  return embeddingPipeline;
}

export async function matchWithEmbeddings({ inventory, allergens, budgetCents, request }) {
  const candidates = safeCandidates(inventory, allergens, budgetCents);
  if (!candidates.length) return { items: [], reason: 'Nothing in today’s case meets those needs.', source: 'rules' };
  try {
    const embed = await getEmbeddingPipeline();
    const phrases = [request, ...candidates.map((item) => `${item.name}. ${item.category}. ${item.description}`)];
    const vectors = (await embed(phrases, { pooling: 'mean', normalize: true })).tolist();
    const query = vectors[0];
    const rankedIds = candidates.map((item, index) => ({
      id: item.id,
      score: query.reduce((sum, value, dimension) => sum + value * vectors[index + 1][dimension], 0)
    })).sort((a, b) => b.score - a.score).map((item) => item.id);
    const items = coverRequestedCourses(normalizeSelection(rankedIds, inventory, allergens, budgetCents), inventory, allergens, budgetCents, request);
    return { items, reason: describeMatch(items), source: 'MiniLM AI' };
  } catch {
    return { items: coverRequestedCourses(fallbackMatch(inventory, allergens, budgetCents, request), inventory, allergens, budgetCents, request), reason: 'A fresh selection from today’s case that fits your limits.', source: 'rules fallback' };
  }
}
