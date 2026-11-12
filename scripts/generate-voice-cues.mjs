import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { voiceCues, elevenLabsSpeech } from '../voice.mjs';

const outputDir = join(process.cwd(), 'public', 'voice');
await mkdir(outputDir, { recursive: true });
for (const [cue, spokenText] of Object.entries(voiceCues)) {
  const audio = await elevenLabsSpeech(spokenText, {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2'
  });
  await writeFile(join(outputDir, `${cue}.mp3`), audio);
  console.log(`${cue}.mp3: ${audio.length} bytes`);
}
