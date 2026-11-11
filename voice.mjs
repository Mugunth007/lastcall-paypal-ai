export const voiceCues = Object.freeze({
  welcome: 'Welcome to LastCall. Tell us what you are craving, set your budget, and we will build a rescue bag from tonight’s fresh bakes.',
  matched: 'Your rescue bag is ready. Every item was checked against your budget and the ingredients you asked us to leave out.',
  reserved: 'Your bag is reserved. Approve the test payment to reveal your pickup code.',
  pickup: 'You are all set. Show your six digit code at the bakery counter. Payment is captured only when you pick up your food.',
  completed: 'Rescued and ready to enjoy. Thanks for giving good food a second chance.',
  counter: 'Welcome to the bakery counter. Update what is left, then confirm each pickup with the customer’s code.'
});

export async function elevenLabsSpeech(text, { apiKey, voiceId = 'JBFqnCBsd6RMkjVDRZzb', modelId = 'eleven_multilingual_v2' }) {
  if (!apiKey) throw new Error('ElevenLabs API key is not configured.');
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } })
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { detail = (await response.json()).detail?.message || detail; } catch {}
    throw new Error(`ElevenLabs voice generation failed: ${detail}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
