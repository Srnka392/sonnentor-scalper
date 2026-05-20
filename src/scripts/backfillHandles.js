import { readFile, writeFile } from 'node:fs/promises';
import { shopifyGraphql } from '../shopify/client.js';

const STATE_PATH = 'data/shopify-state.json';
const CHUNK_SIZE = 100;

async function main() {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    const entries = Object.entries(state.productResolutions);
    const needsBackfill = entries.filter(([, value]) => value?.gid && !value.handle);
    console.log(`Total resolutions: ${entries.length}. Need handle backfill: ${needsBackfill.length}.`);
    if (!needsBackfill.length) return;
    for (let i = 0; i < needsBackfill.length; i += CHUNK_SIZE) {
        const chunk = needsBackfill.slice(i, i + CHUNK_SIZE);
        const aliasedQuery = chunk
            .map(([, value], j) => `  p${j}: product(id: "${value.gid}") { id handle title }`)
            .join('\n');
        const data = await shopifyGraphql(`query {\n${aliasedQuery}\n}`);
        for (let j = 0; j < chunk.length; j += 1) {
            const [sourceHandle] = chunk[j];
            const product = data[`p${j}`];
            if (product?.handle) {
                state.productResolutions[sourceHandle].handle = product.handle;
            }
        }
        console.log(`Filled handles for ${Math.min(i + CHUNK_SIZE, needsBackfill.length)}/${needsBackfill.length}`);
    }
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    console.log('Wrote state with handles.');
}

main().catch((err) => { console.error(err); process.exit(1); });
