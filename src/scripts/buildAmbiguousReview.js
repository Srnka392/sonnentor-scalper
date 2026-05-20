import { readFile, writeFile, unlink } from 'node:fs/promises';
import { request } from 'undici';
import pLimit from 'p-limit';

const SOURCE_CSV = 'data/product-suggestions-ambiguous.csv';
const REVIEW_MD = 'data/AMBIGUOUS_REVIEW.md';
const LEGACY_CSV = 'data/AMBIGUOUS_REVIEW.csv';
const STALE_LOG = 'data/AMBIGUOUS_REVIEW.stale.json';

const SHOPIFY_ADMIN_BASE = 'https://sonnentor-dev.myshopify.com/admin/products';
const SHOPIFY_STOREFRONT_BASE = 'https://sonnentor-dev.myshopify.com/products';

function parseCsvLine(line) {
    const parts = [];
    let currentValue = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const character = line[i];
        if (inQuotes) {
            if (character === '"' && line[i + 1] === '"') { currentValue += '"'; i += 1; }
            else if (character === '"') inQuotes = false;
            else currentValue += character;
        } else {
            if (character === ',') { parts.push(currentValue); currentValue = ''; }
            else if (character === '"') inQuotes = true;
            else currentValue += character;
        }
    }
    parts.push(currentValue);
    return parts;
}

function gidToAdminLink(gid) {
    if (!gid) return '';
    const numericId = gid.split('/').pop();
    return `${SHOPIFY_ADMIN_BASE}/${numericId}`;
}

async function isSourceUrlLive(url) {
    if (!url) return false;
    try {
        const response = await request(url, {
            method: 'HEAD',
            maxRedirections: 0,
            headers: { 'user-agent': 'sonnentor-migration/0.1' },
        });
        await response.body.dump();
        return response.statusCode === 200;
    } catch {
        return false;
    }
}

async function buildSourceUrlIndex() {
    const sourceUrlByHandle = new Map();
    function indexFrom(items) {
        for (const item of items) {
            for (const product of (item.relatedProducts || [])) {
                if (product.sourceHandle && product.sourceUrl && !sourceUrlByHandle.has(product.sourceHandle)) {
                    sourceUrlByHandle.set(product.sourceHandle, product.sourceUrl);
                }
            }
        }
    }
    for (const file of ['data/recipes.json', 'data/articles.json', 'data/herbarium.json']) {
        try {
            indexFrom(JSON.parse(await readFile(file, 'utf8')));
        } catch {
            // skip missing scrape files
        }
    }
    return sourceUrlByHandle;
}

async function main() {
    const sourceUrlByHandle = await buildSourceUrlIndex();

    const csv = await readFile(SOURCE_CSV, 'utf8');
    const lines = csv.split('\n').filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const idx = (name) => header.indexOf(name);
    const rows = lines.slice(1).map(parseCsvLine);

    const enriched = rows.map((row) => ({
        sourceHandle: row[idx('sourceHandle')],
        sourceTitle: row[idx('sourceTitle')],
        sourceImage: row[idx('sourceImage')],
        sourceCode: row[idx('sourceCode')],
        referenceCount: Number(row[idx('referenceCount')] || 0),
        candidates: [1, 2, 3].map((n) => ({
            gid: row[idx(`cand${n}_gid`)],
            handle: row[idx(`cand${n}_handle`)],
            title: row[idx(`cand${n}_title`)],
            score: Number(row[idx(`cand${n}_score`)] || 0),
        })).filter((c) => c.gid),
    }));

    // Verify each source URL is live (200) — drop entries whose product was deleted/renamed
    // on the source store and now 301s back to a category page.
    console.log(`Checking ${enriched.length} source URLs for live products…`);
    const checkLimit = pLimit(8);
    const liveResults = await Promise.all(
        enriched.map((entry) => checkLimit(async () => {
            const url = sourceUrlByHandle.get(entry.sourceHandle);
            const live = await isSourceUrlLive(url);
            return { entry, live, url };
        })),
    );
    const stale = liveResults.filter((result) => !result.live);
    const liveEntries = liveResults.filter((result) => result.live).map((result) => result.entry);
    await writeFile(
        STALE_LOG,
        JSON.stringify(stale.map((result) => ({ sourceHandle: result.entry.sourceHandle, sourceUrl: result.url, sourceTitle: result.entry.sourceTitle })), null, 2),
        'utf8',
    );
    console.log(`Live products: ${liveEntries.length}. Stale (dropped): ${stale.length}. Stale list → ${STALE_LOG}`);

    liveEntries.sort((a, b) => {
        const scoreA = a.candidates[0]?.score ?? 0;
        const scoreB = b.candidates[0]?.score ?? 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return b.referenceCount - a.referenceCount;
    });

    const highConfidence = liveEntries.filter((entry) => (entry.candidates[0]?.score ?? 0) >= 0.5);
    const mediumConfidence = liveEntries.filter((entry) => {
        const top = entry.candidates[0]?.score ?? 0;
        return top >= 0.3 && top < 0.5;
    });
    const lowOrNone = liveEntries.filter((entry) => (entry.candidates[0]?.score ?? 0) < 0.3);

    const markdownLines = [
        '# Ambiguous product mapping review',
        '',
        '**Workflow:** for each entry, place an `x` inside the checkbox `[ ]` next to the correct candidate (e.g. `[x]`). Leave everything unchecked if no candidate is correct. Save the file, then run `node src/scripts/applyMapping.js` — it parses this Markdown and applies the chosen mappings to state. Finally re-run `npm run import -- articles && npm run import -- recipes && npm run import -- herbarium` to refresh `sga.related_products` metafields.',
        '',
        `- High confidence (top score ≥ 0.5): **${highConfidence.length}** entries — usually correct, scan quickly.`,
        `- Medium confidence (0.3 – 0.5): **${mediumConfidence.length}** entries — careful look.`,
        `- Low / no match (< 0.3): **${lowOrNone.length}** entries — likely no product (or category URL).`,
        '',
        '---',
        '',
    ];

    function renderEntry(entry) {
        markdownLines.push(`### ${entry.sourceHandle} — _"${entry.sourceTitle}"_`);
        markdownLines.push('');
        const sourceLinks = [];
        const sourceUrl = sourceUrlByHandle.get(entry.sourceHandle);
        if (sourceUrl) {
            sourceLinks.push(`[old store URL](${sourceUrl}) _(may 301 to category if product was renamed/removed)_`);
        }
        if (entry.sourceImage) sourceLinks.push(`[image](${entry.sourceImage})`);
        if (entry.sourceCode) sourceLinks.push(`code \`${entry.sourceCode}\``);
        sourceLinks.push(`referenced ${entry.referenceCount}×`);
        markdownLines.push(`- ${sourceLinks.join(' · ')}`);
        markdownLines.push('');
        if (!entry.candidates.length) {
            markdownLines.push('_No reasonable candidates found in Shopify — likely needs a new product or is not a product (category URL)._');
            markdownLines.push('');
            return;
        }
        markdownLines.push('| pick | Shopify title | handle | score | storefront | admin |');
        markdownLines.push('|---|---|---|---|---|---|');
        entry.candidates.forEach((candidate) => {
            const storefrontUrl = `${SHOPIFY_STOREFRONT_BASE}/${candidate.handle}`;
            markdownLines.push(
                `| [ ] | ${candidate.title} | \`${candidate.handle}\` | ${candidate.score.toFixed(2)} | [view](${storefrontUrl}) | [edit](${gidToAdminLink(candidate.gid)}) |`,
            );
        });
        markdownLines.push('');
    }

    function renderSection(name, items) {
        markdownLines.push(`## ${name} (${items.length})`);
        markdownLines.push('');
        items.forEach(renderEntry);
    }

    renderSection('High confidence (≥ 0.5)', highConfidence);
    renderSection('Medium confidence (0.3 – 0.5)', mediumConfidence);
    renderSection('Low / no match (< 0.3)', lowOrNone);

    await writeFile(REVIEW_MD, markdownLines.join('\n'), 'utf8');
    console.log(`Wrote ${REVIEW_MD}`);

    // Drop the legacy CSV if it exists from a previous run.
    try { await unlink(LEGACY_CSV); console.log(`Removed legacy ${LEGACY_CSV}`); } catch {}
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
