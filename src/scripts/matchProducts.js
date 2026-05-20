import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { shopifyGraphql } from '../shopify/client.js';

const SHOPIFY_PRODUCT_PAGE_SIZE = 100;
const TITLE_MATCH_THRESHOLD = 0.6; // Jaccard token similarity
const STATE_PATH = 'data/shopify-state.json';
const SUGGESTIONS_CSV = 'data/product-suggestions.csv';
const AMBIGUOUS_CSV = 'data/product-suggestions-ambiguous.csv';

function extractProductCode(imageUrl) {
    if (!imageUrl) return null;
    const lastSegment = imageUrl.split('/').pop().split('?')[0];
    const code = lastSegment.split('.')[0];
    return /^\d{4,6}$/.test(code) ? code : null;
}

function normalizeTitle(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tokenize(text) {
    const normalized = normalizeTitle(text);
    if (!normalized) return new Set();
    return new Set(
        normalized
            .split(/\s+/)
            .filter((token) => token.length >= 2),
    );
}

function jaccardSimilarity(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let intersection = 0;
    for (const token of setA) if (setB.has(token)) intersection += 1;
    const union = setA.size + setB.size - intersection;
    return union ? intersection / union : 0;
}

async function fetchAllShopifyProducts() {
    const products = [];
    let cursor = null;
    while (true) {
        const cursorArg = cursor ? `, after: "${cursor}"` : '';
        const data = await shopifyGraphql(`query {
            products(first: ${SHOPIFY_PRODUCT_PAGE_SIZE}${cursorArg}) {
                nodes { id handle title featuredImage { url } }
                pageInfo { hasNextPage endCursor }
            }
        }`);
        products.push(...data.products.nodes);
        if (!data.products.pageInfo.hasNextPage) break;
        cursor = data.products.pageInfo.endCursor;
    }
    return products;
}

function loadUnresolvedSources(scrapedData) {
    const byHandle = new Map();
    function addReference(item, referencedFrom) {
        if (!item.sourceHandle) return;
        const existing = byHandle.get(item.sourceHandle);
        if (existing) {
            existing.referenceCount += 1;
            if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
            if (!existing.title && item.title) existing.title = item.title;
            return;
        }
        byHandle.set(item.sourceHandle, {
            sourceHandle: item.sourceHandle,
            sourceUrl: item.sourceUrl,
            title: item.title,
            imageUrl: item.imageUrl,
            referenceCount: 1,
        });
    }
    for (const recipe of scrapedData.recipes) {
        recipe.relatedProducts?.forEach((p) => addReference(p, `recipe:${recipe.handle}`));
    }
    for (const article of scrapedData.articles) {
        article.relatedProducts?.forEach((p) => addReference(p, `article:${article.handle}`));
    }
    for (const herb of scrapedData.herbarium) {
        herb.relatedProducts?.forEach((p) => addReference(p, `herb:${herb.handle}`));
    }
    return [...byHandle.values()];
}

function csvEscape(value) {
    const stringified = String(value ?? '');
    if (/[,"\n\r]/.test(stringified)) {
        return `"${stringified.replace(/"/g, '""')}"`;
    }
    return stringified;
}

function writeCsvRow(parts) {
    return parts.map(csvEscape).join(',');
}

async function main() {
    console.log('Loading scraped data…');
    const scrapedData = {
        recipes: JSON.parse(await readFile('data/recipes.json', 'utf8')),
        articles: JSON.parse(await readFile('data/articles.json', 'utf8')),
        herbarium: JSON.parse(await readFile('data/herbarium.json', 'utf8')),
    };
    const sourceProducts = loadUnresolvedSources(scrapedData);
    console.log(`Found ${sourceProducts.length} unique source products referenced.`);

    let state;
    try {
        state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    } catch {
        state = { productResolutions: {}, unresolvedProducts: [] };
    }
    const alreadyResolved = new Set(
        Object.entries(state.productResolutions)
            .filter(([, value]) => value?.gid)
            .map(([key]) => key),
    );
    const unresolved = sourceProducts.filter((p) => !alreadyResolved.has(p.sourceHandle));
    console.log(`Already resolved: ${alreadyResolved.size}. Remaining to match: ${unresolved.length}.`);

    console.log('Fetching all Shopify products…');
    const shopifyProducts = await fetchAllShopifyProducts();
    console.log(`Fetched ${shopifyProducts.length} products from Shopify.`);

    const codeToShopifyProduct = new Map();
    const titleTokenizedShopify = shopifyProducts.map((product) => ({
        product,
        tokens: tokenize(product.title),
        code: extractProductCode(product.featuredImage?.url),
    }));
    for (const entry of titleTokenizedShopify) {
        if (entry.code) {
            const existing = codeToShopifyProduct.get(entry.code);
            if (!existing) codeToShopifyProduct.set(entry.code, []);
            codeToShopifyProduct.get(entry.code).push(entry.product);
        }
    }
    console.log(`${codeToShopifyProduct.size} distinct product codes seen in Shopify image filenames.`);

    const autoAccepted = [];
    const needsReview = [];
    for (const source of unresolved) {
        const sourceCode = extractProductCode(source.imageUrl);
        const sourceTokens = tokenize(source.title);
        let codeMatch = null;
        if (sourceCode) {
            const candidates = codeToShopifyProduct.get(sourceCode) ?? [];
            if (candidates.length === 1) {
                codeMatch = candidates[0];
            } else if (candidates.length > 1 && sourceTokens.size) {
                // disambiguate by best title overlap
                candidates.sort((a, b) =>
                    jaccardSimilarity(tokenize(b.title), sourceTokens) - jaccardSimilarity(tokenize(a.title), sourceTokens),
                );
                codeMatch = candidates[0];
            }
        }

        const titleScored = titleTokenizedShopify
            .map((entry) => ({ product: entry.product, score: jaccardSimilarity(entry.tokens, sourceTokens), code: entry.code }))
            .filter((entry) => entry.score >= 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

        if (codeMatch) {
            autoAccepted.push({
                ...source,
                resolvedGid: codeMatch.id,
                resolvedHandle: codeMatch.handle,
                resolvedTitle: codeMatch.title,
                method: 'image-code',
                sourceCode,
                topByTitle: titleScored,
            });
            continue;
        }

        const topByTitle = titleScored[0];
        const secondScore = titleScored[1]?.score ?? 0;
        const gap = (topByTitle?.score ?? 0) - secondScore;
        if (topByTitle && topByTitle.score >= 0.5 && gap >= 0.15) {
            autoAccepted.push({
                ...source,
                resolvedGid: topByTitle.product.id,
                resolvedHandle: topByTitle.product.handle,
                resolvedTitle: topByTitle.product.title,
                method: `title-fuzzy-${topByTitle.score.toFixed(2)}`,
                sourceCode,
                topByTitle: titleScored,
            });
            continue;
        }

        needsReview.push({ ...source, sourceCode, topByTitle: titleScored });
    }

    console.log(`Auto-accepted: ${autoAccepted.length}. Need manual review: ${needsReview.length}.`);

    // Persist auto-accepted matches to state so a subsequent re-import can use them
    for (const match of autoAccepted) {
        state.productResolutions[match.sourceHandle] = {
            gid: match.resolvedGid,
            matchedBy: match.method,
            title: match.resolvedTitle,
        };
    }
    await mkdir('data', { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    console.log(`Wrote ${STATE_PATH} (productResolutions updated).`);

    // Build CSVs
    const acceptedHeader = ['sourceHandle', 'sourceTitle', 'sourceImage', 'sourceCode', 'resolvedGid', 'resolvedHandle', 'resolvedTitle', 'method', 'referenceCount'];
    const acceptedLines = [acceptedHeader.join(',')];
    for (const match of autoAccepted) {
        acceptedLines.push(writeCsvRow([
            match.sourceHandle, match.title, match.imageUrl, match.sourceCode ?? '',
            match.resolvedGid, match.resolvedHandle, match.resolvedTitle, match.method, match.referenceCount,
        ]));
    }
    await writeFile(SUGGESTIONS_CSV, acceptedLines.join('\n') + '\n', 'utf8');
    console.log(`Wrote ${SUGGESTIONS_CSV} (${autoAccepted.length} rows).`);

    const ambHeader = ['sourceHandle', 'sourceTitle', 'sourceImage', 'sourceCode', 'referenceCount',
        'cand1_gid', 'cand1_handle', 'cand1_title', 'cand1_score',
        'cand2_gid', 'cand2_handle', 'cand2_title', 'cand2_score',
        'cand3_gid', 'cand3_handle', 'cand3_title', 'cand3_score',
        'accepted_gid'];
    const ambLines = [ambHeader.join(',')];
    for (const entry of needsReview) {
        const parts = [
            entry.sourceHandle, entry.title, entry.imageUrl, entry.sourceCode ?? '', entry.referenceCount,
        ];
        for (let i = 0; i < 3; i++) {
            const candidate = entry.topByTitle[i];
            if (candidate) {
                parts.push(candidate.product.id, candidate.product.handle, candidate.product.title, candidate.score.toFixed(3));
            } else {
                parts.push('', '', '', '');
            }
        }
        parts.push(''); // accepted_gid — to be filled by user
        ambLines.push(writeCsvRow(parts));
    }
    await writeFile(AMBIGUOUS_CSV, ambLines.join('\n') + '\n', 'utf8');
    console.log(`Wrote ${AMBIGUOUS_CSV} (${needsReview.length} rows). Fill "accepted_gid" column and run "apply-mapping".`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
