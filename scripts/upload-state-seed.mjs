import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { put } from '@vercel/blob';

if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is required.');
const seed = await readFile(join(process.cwd(), '.data', 'vercel-seed.json'));
const result = await put('lastcall/state.json', seed, {
  access: 'private',
  contentType: 'application/json',
  token: process.env.BLOB_READ_WRITE_TOKEN
});
console.log(`Seed uploaded: ${result.pathname}`);
