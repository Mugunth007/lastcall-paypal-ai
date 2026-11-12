import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seedInventory } from '../catalog.mjs';

const directory = join(process.cwd(), '.data');
await mkdir(directory, { recursive: true });
const output = join(directory, 'vercel-seed.json');
await writeFile(output, JSON.stringify({ inventory: seedInventory, orders: [], savedItems: 0, savedValueCents: 0 }, null, 2));
console.log(`Seed saved: ${output}`);
