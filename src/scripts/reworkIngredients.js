import { readFile, writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { config } from '../config.js';
import { stripWhitespace } from '../utils.js';
import { findArticleInBlog } from '../shopify/articles.js';
import { findProductByHandle } from '../shopify/products.js';
import { setMetafields } from '../shopify/metafields.js';

const RECIPES_PATH = 'data/recipes.json';
const PRODUCTS_MAPPING_PATH = 'exports/products-mapping.csv';
const EXPORT_CSV_PATH = 'exports/recipes.csv';
const BLOG_HANDLE = 'recipes';
const SGA_NAMESPACE = 'sga';

// New consolidated metafields.
const INGREDIENTS_KEY = 'ingredients';
const INGREDIENTS_TYPE = 'list.single_line_text_field';
const INGREDIENT_PRODUCTS_KEY = 'ingredient_products';
const INGREDIENT_PRODUCTS_TYPE = 'list.product_reference';
const EYEBROW_KEY = 'eyebrow';
const EYEBROW_TYPE = 'single_line_text_field';

// Politeness delay between Admin writes (the GraphQL client also self-throttles).
const REQUEST_DELAY_MS = 120;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Known Czech measurement units that may follow a leading quantity. Only when the
// token right after the number is in this set do we split it off as `unit`; everything
// else (e.g. "2 vejce", "5 mrkví") keeps an empty unit and the noun stays in `label`.
// All comparisons are case-insensitive.
const KNOWN_UNITS = new Set([
    'ks',
    'g', 'dkg', 'kg',
    'ml', 'cl', 'dl', 'l',
    'mm', 'cm',
    'lžíce', 'lžíci', 'lžic', 'lžička', 'lžičku', 'lžičky', 'lžiček',
    'hrnek', 'hrnku', 'hrnky', 'hrnků',
    'špetka', 'špetku', 'špetky',
    'balení',
    'stroužek', 'stroužky', 'stroužků',
    'snítka', 'snítky', 'snítek',
    'plátek', 'plátky', 'plátků',
    'konzerva', 'konzervy',
    'sáček', 'sáčky', 'sáčků',
    'hrst', 'hrsti', 'hrstí',
].map((unit) => unit.toLowerCase()));

// Leading-quantity matcher: integer, decimal (dot or comma), or simple fraction a/b.
const QUANTITY_TOKEN = /^(\d+\/\d+|\d+(?:[.,]\d+)?)$/;

function quantityTokenToDecimal(token) {
    if (token.includes('/')) {
        const [numerator, denominator] = token.split('/').map(Number);
        if (!denominator) return null;
        const value = numerator / denominator;
        return formatDecimal(value);
    }
    const value = Number(token.replace(',', '.'));
    if (Number.isNaN(value)) return null;
    return formatDecimal(value);
}

// Render without trailing zeros / locale separators: 0.5, 1, 1.25, 0.125.
function formatDecimal(value) {
    return String(Number(value.toFixed(6)));
}

// Strip any `[[...]]` product marker (products are carried separately by the
// ingredient_products metafield) and collapse whitespace.
function stripProductMarker(text) {
    return stripWhitespace(text.replace(/\[\[[^\]]*\]\]/g, ''));
}

// Parse one ingredient line into `qty|unit|label` (always exactly two pipes).
// Conservative: only peel off qty/unit when the leading token is clearly numeric and
// (for unit) the next token is a known unit. Otherwise everything lands in `label`.
export function parseIngredientLine(rawText) {
    const cleaned = stripProductMarker(rawText);
    if (!cleaned) return '||';

    const tokens = cleaned.split(/\s+/);
    let qty = '';
    let unit = '';
    let rest = tokens;

    if (QUANTITY_TOKEN.test(tokens[0])) {
        const decimal = quantityTokenToDecimal(tokens[0]);
        if (decimal != null) {
            qty = decimal;
            rest = tokens.slice(1);
            if (rest.length > 1 && KNOWN_UNITS.has(rest[0].toLowerCase())) {
                unit = rest[0];
                rest = rest.slice(1);
            }
        }
    }

    const label = rest.join(' ');
    return `${qty}|${unit}|${label}`;
}

// Flatten ingredientGroups (1→5) in order into a single ordered array of formatted lines.
// Headings are dropped entirely by design. Product-linked items (those carrying a
// `productSourceHandle`) are EXCLUDED — they live solely in the ingredient_products
// metafield, never in the plain-text ingredients list.
export function buildIngredientLines(ingredientGroups) {
    const lines = [];
    if (!Array.isArray(ingredientGroups)) return lines;
    for (const group of ingredientGroups) {
        for (const item of group.items || []) {
            const handle = item && typeof item === 'object' ? item.productSourceHandle : null;
            if (handle) continue; // product-linked → ingredient_products only
            const text = typeof item === 'string' ? item : item.text;
            if (!text) continue;
            lines.push(parseIngredientLine(text));
        }
    }
    return lines;
}

// Collect the source product handles referenced by a recipe's ingredients, in order,
// de-duplicated.
export function collectProductSourceHandles(ingredientGroups) {
    const handles = [];
    const seen = new Set();
    if (!Array.isArray(ingredientGroups)) return handles;
    for (const group of ingredientGroups) {
        for (const item of group.items || []) {
            const handle = item && typeof item === 'object' ? item.productSourceHandle : null;
            if (handle && !seen.has(handle)) {
                seen.add(handle);
                handles.push(handle);
            }
        }
    }
    return handles;
}

// products-mapping.csv: source_handle,shopify_product_id,shopify_product_handle
async function loadProductMapping() {
    const raw = await readFile(PRODUCTS_MAPPING_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const map = new Map();
    for (const line of lines.slice(1)) {
        const [sourceHandle, , shopifyHandle] = line.split(',');
        if (sourceHandle && shopifyHandle) {
            map.set(sourceHandle.trim(), shopifyHandle.trim());
        }
    }
    return map;
}

// Eyebrow is a fixed kicker "Recept" for every recipe (matches the live
// `.recipe__toptitle`). Per client: do not use the category list here.
export function eyebrowFromRecipe() {
    return 'Recept';
}

function parseArgs(argv) {
    const args = { dryRun: false, limit: null, handles: null, exportOnly: false, noExport: false };
    for (const token of argv) {
        if (token === '--dry' || token === '--dry-run') args.dryRun = true;
        else if (token === '--export-only') args.exportOnly = true;
        else if (token === '--no-export') args.noExport = true;
        else if (token.startsWith('--limit=')) args.limit = Number(token.slice('--limit='.length));
        else if (token.startsWith('--handles=')) {
            args.handles = token.slice('--handles='.length).split(',').map((h) => h.trim()).filter(Boolean);
        }
    }
    return args;
}

async function loadRecipes() {
    return JSON.parse(await readFile(RECIPES_PATH, 'utf8'));
}

// Resolve a recipe's referenced products. Returns:
//  - gids: CURRENT dev-store product gids (only those that actually resolve in this store) —
//    used for the live metafield write. The dev store was rebuilt with ~69 products, so most
//    handles won't resolve here; those are skipped and counted.
//  - exportHandles: the mapped Shopify product HANDLES for every referenced product that has
//    a row in products-mapping.csv (regardless of whether it exists in THIS dev store). These
//    go into the exports CSV so a production import resolves them by handle.
async function resolveIngredientProducts(recipe, productMapping, resolveCache) {
    const sourceHandles = collectProductSourceHandles(recipe.ingredientGroups);
    const gids = [];
    const exportHandles = [];
    let skipped = 0;
    for (const sourceHandle of sourceHandles) {
        const shopifyHandle = productMapping.get(sourceHandle);
        if (!shopifyHandle) {
            skipped += 1;
            continue;
        }
        exportHandles.push(shopifyHandle);
        let gid = resolveCache.get(shopifyHandle);
        if (gid === undefined) {
            const product = await findProductByHandle(shopifyHandle);
            gid = product?.id ?? null;
            resolveCache.set(shopifyHandle, gid);
        }
        if (gid) gids.push(gid);
        else skipped += 1;
    }
    return { gids, exportHandles, skipped, referenced: sourceHandles.length };
}

// ---- CSV export (Matrixify Blog Posts format, new ingredient model) ----

const CSV_COLUMNS = [
    'Handle',
    'Command',
    'Title',
    'Author',
    'Body HTML',
    'Summary HTML',
    'Tags',
    'Tags Command',
    'Published',
    'Published At',
    'Image Src',
    'Image Alt Text',
    'Blog: Handle',
    'Metafield: sga.thumbnail [file_reference]',
    'Metafield: sga.total_time_minutes [number_integer]',
    'Metafield: sga.servings [number_integer]',
    'Metafield: sga.dietary [list.single_line_text_field]',
    'Metafield: sga.main_product [product_reference]',
    'Metafield: sga.related_products [list.product_reference]',
    'Metafield: sga.related_articles [list.article_reference]',
    'Metafield: sga.you_might_also_like [list.article_reference]',
    'Metafield: sga.you_might_also_like_heading [single_line_text_field]',
    'Metafield: sga.related_products_heading [single_line_text_field]',
    'Metafield: sga.ingredients [list.single_line_text_field]',
    'Metafield: sga.ingredient_products [list.product_reference]',
    'Metafield: sga.eyebrow [single_line_text_field]',
    'Metafield: sga.serving_tip [single_line_text_field]',
    'Metafield: sga.difficulty [single_line_text_field]',
    'Metafield: sga.instructions [list.single_line_text_field]',
];

function csvCell(value) {
    const text = value == null ? '' : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function csvRow(values) {
    return values.map(csvCell).join(',');
}

function instructionTexts(recipe) {
    return (recipe.instructions || [])
        .map((step) => (typeof step === 'string' ? step : step.text))
        .filter(Boolean);
}

function buildCsvRow(recipe, ingredientLines, ingredientProductHandles, eyebrow) {
    const tags = Array.isArray(recipe.tags) ? recipe.tags.join(', ') : '';
    return csvRow([
        recipe.handle,
        'MERGE',
        recipe.title,
        'Sonnentor',
        '', // Body HTML — recipes render from metafields
        recipe.excerpt || recipe.description || '',
        tags,
        'REPLACE',
        'TRUE',
        '',
        recipe.heroImage?.sourceUrl || '',
        recipe.heroImage?.alt || recipe.title || '',
        BLOG_HANDLE,
        recipe.handle ? `${recipe.handle}-thumb.jpg` : '',
        recipe.totalTimeMinutes ?? '',
        recipe.servings ?? '',
        Array.isArray(recipe.dietary) ? recipe.dietary.join(', ') : '',
        '', // main_product — out of scope for this rework
        '', // related_products
        Array.isArray(recipe.relatedArticles) ? recipe.relatedArticles.map((a) => a.sourceHandle || a).join(', ') : '',
        Array.isArray(recipe.youMightAlsoLike) ? recipe.youMightAlsoLike.map((a) => a.sourceHandle || a).join(', ') : '',
        recipe.youMightAlsoLikeHeading || '',
        recipe.relatedProductsHeading || '',
        JSON.stringify(ingredientLines),
        ingredientProductHandles.join(', '),
        eyebrow,
        '', // serving_tip — not present on live site
        '', // difficulty — not present on live site
        JSON.stringify(instructionTexts(recipe)),
    ]);
}

async function writeCsv(rows) {
    const content = [csvRow(CSV_COLUMNS), ...rows].join('\n') + '\n';
    await writeFile(EXPORT_CSV_PATH, content, 'utf8');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const allRecipes = await loadRecipes();

    let recipes = allRecipes;
    if (args.handles) {
        const wanted = new Set(args.handles);
        recipes = allRecipes.filter((recipe) => wanted.has(recipe.handle));
        const found = new Set(recipes.map((r) => r.handle));
        args.handles.filter((h) => !found.has(h)).forEach((h) => {
            console.error(`  ! requested handle not found in ${RECIPES_PATH}: ${h}`);
        });
    }
    if (args.limit != null) recipes = recipes.slice(0, args.limit);

    const productMapping = await loadProductMapping();
    const resolveCache = new Map();

    console.log(
        `Reworking ingredients for ${recipes.length} recipe(s) ` +
        `(dryRun=${args.dryRun}, exportOnly=${args.exportOnly}, noExport=${args.noExport}).`,
    );

    // Stats
    let processed = 0;
    let written = 0;
    let totalResolved = 0;
    let totalSkipped = 0;
    let recipesWithZeroResolved = 0;
    let recipesReferencingProducts = 0;
    let totalLinesExcludedAsProducts = 0;
    const csvRowByHandle = new Map();

    // Product resolution touches the Admin API, so keep concurrency modest and ordered.
    const limit = pLimit(config.concurrency.scrape);

    await Promise.all(
        recipes.map((recipe) =>
            limit(async () => {
                try {
                    const ingredientLines = buildIngredientLines(recipe.ingredientGroups);
                    const eyebrow = eyebrowFromRecipe(recipe);

                    let resolution = { gids: [], exportHandles: [], skipped: 0, referenced: 0 };
                    if (!args.exportOnly || args.dryRun) {
                        resolution = await resolveIngredientProducts(recipe, productMapping, resolveCache);
                    } else {
                        // export-only without resolving would emit empty product lists; resolve anyway
                        resolution = await resolveIngredientProducts(recipe, productMapping, resolveCache);
                    }

                    processed += 1;
                    totalResolved += resolution.gids.length;
                    totalSkipped += resolution.skipped;
                    totalLinesExcludedAsProducts += resolution.referenced;
                    if (resolution.referenced > 0) recipesReferencingProducts += 1;
                    if (resolution.referenced > 0 && resolution.gids.length === 0) recipesWithZeroResolved += 1;

                    csvRowByHandle.set(
                        recipe.handle,
                        buildCsvRow(recipe, ingredientLines, resolution.exportHandles, eyebrow),
                    );

                    if (args.dryRun) {
                        console.log(`\n=== ${recipe.handle} ===`);
                        console.log(`    ingredients (${ingredientLines.length}):`);
                        ingredientLines.forEach((line) => console.log(`      ${JSON.stringify(line)}`));
                        console.log(`    ingredient_products: ${resolution.gids.length} resolved / ` +
                            `${resolution.skipped} skipped (of ${resolution.referenced} referenced)`);
                        console.log(`      export product handles: ${JSON.stringify(resolution.exportHandles)}`);
                        resolution.gids.forEach((gid) => console.log(`      gid: ${gid}`));
                        console.log(`    eyebrow: ${JSON.stringify(eyebrow)}`);
                        console.log(`    serving_tip: (none on live site)`);
                        console.log(`    difficulty: (none on live site)`);
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    if (args.exportOnly) {
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    const article = await findArticleInBlog(BLOG_HANDLE, recipe.handle);
                    if (!article) {
                        console.error(`  ✗ ${recipe.handle}: no matching article in blog '${BLOG_HANDLE}'`);
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    const metafields = [
                        {
                            ownerId: article.id,
                            namespace: SGA_NAMESPACE,
                            key: INGREDIENTS_KEY,
                            type: INGREDIENTS_TYPE,
                            value: JSON.stringify(ingredientLines),
                        },
                    ];
                    // Skip-on-zero: only write ingredient_products when we resolved ≥1 product,
                    // so a recipe whose live products aren't in the dev store keeps any curated
                    // value (e.g. the mrkvovo-zazvorova-polevka demo's 4 hand-picked products)
                    // instead of being clobbered with an empty list.
                    if (resolution.gids.length > 0) {
                        metafields.push({
                            ownerId: article.id,
                            namespace: SGA_NAMESPACE,
                            key: INGREDIENT_PRODUCTS_KEY,
                            type: INGREDIENT_PRODUCTS_TYPE,
                            value: JSON.stringify(resolution.gids),
                        });
                    }
                    if (eyebrow) {
                        metafields.push({
                            ownerId: article.id,
                            namespace: SGA_NAMESPACE,
                            key: EYEBROW_KEY,
                            type: EYEBROW_TYPE,
                            value: eyebrow,
                        });
                    }

                    await setMetafields(metafields);
                    written += 1;
                    const productsNote = resolution.referenced > 0 && resolution.gids.length === 0
                        ? `${resolution.gids.length}/${resolution.referenced} products (ingredient_products skipped — not clobbering curated value)`
                        : `${resolution.gids.length}/${resolution.referenced} products`;
                    console.log(
                        `  ✓ ${recipe.handle}: ${ingredientLines.length} ingredients, ` +
                        `${productsNote} → ${article.id}`,
                    );
                    await delay(REQUEST_DELAY_MS);
                } catch (err) {
                    console.error(`  ✗ ${recipe.handle}: ${err.message.slice(0, 250)}`);
                }
            }),
        ),
    );

    // Regenerate the export CSV (full run only — keep dry-run read-only).
    if (!args.dryRun && !args.noExport && !args.handles && args.limit == null) {
        const orderedRows = allRecipes
            .map((recipe) => csvRowByHandle.get(recipe.handle))
            .filter(Boolean);
        await writeCsv(orderedRows);
        console.log(`\nWrote ${orderedRows.length} rows → ${EXPORT_CSV_PATH}`);
    } else if (!args.dryRun) {
        console.log('\nSkipped CSV export (partial run — use a full run with no --handles/--limit to regenerate exports/recipes.csv).');
    }

    console.log(
        `\nDone. processed=${processed} written=${written} ` +
        `linesExcludedAsProducts=${totalLinesExcludedAsProducts} ` +
        `productsResolved=${totalResolved} productsSkipped=${totalSkipped} ` +
        `recipesReferencingProducts=${recipesReferencingProducts} ` +
        `recipesWithZeroResolved=${recipesWithZeroResolved}`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
