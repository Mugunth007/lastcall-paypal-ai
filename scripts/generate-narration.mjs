import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { elevenLabsSpeech } from '../voice.mjs';

const text = `Meet LastCall. At the end of the day, good bakery food often goes unsold. LastCall turns it into a personalized rescue bag. Tell us what you want, choose a budget, and flag an ingredient to avoid. The AI suggests a bundle from the stock actually on the shelf, while server rules check the price and allergen labels. Reserve your bag and approve the payment. For this preview, payments are clearly simulated; with PayPal sandbox credentials, the same flow authorizes a test payment. The buyer receives a six digit pickup code. At the bakery counter, staff enter that code to confirm handoff, and only then is the payment captured. If pickup is cancelled, the authorization is voided and the food returns to the shelf. Less waste, a better price, and a little more good in someone's day.`;

const audio = await elevenLabsSpeech(text, {
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
  modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2'
});
const output = join(process.cwd(), '.data', 'demo', 'narration.mp3');
await mkdir(join(process.cwd(), '.data', 'demo'), { recursive: true });
await writeFile(output, audio);
console.log(`Narration saved: ${output} (${audio.length} bytes)`);
