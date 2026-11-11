import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const outputDir = join(process.cwd(), 'demo');
await mkdir(outputDir, { recursive: true });
const args = [
  '-y',
  '-i', join(process.cwd(), '.data', 'demo', 'walkthrough.webm'),
  '-i', join(process.cwd(), '.data', 'demo', 'narration.mp3'),
  '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=6,fade=t=out:st=48:d=1.5,format=yuv420p[v];[1:a]afade=t=in:st=0:d=0.35,afade=t=out:st=48:d=1.3[a]',
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
  '-c:a', 'aac', '-b:a', '160k', '-shortest',
  join(outputDir, 'lastcall-demo.mp4')
];
const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
const exitCode = await new Promise((resolve, reject) => {
  ffmpeg.on('error', reject);
  ffmpeg.on('close', resolve);
});
if (exitCode !== 0) process.exit(exitCode || 1);
console.log(`Demo video saved: ${join(outputDir, 'lastcall-demo.mp4')}`);
