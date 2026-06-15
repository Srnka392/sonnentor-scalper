import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { fetchHtml } from '../fetcher.js';
import { stripWhitespace } from '../utils.js';
import { config } from '../config.js';
import { findArticleInBlog } from '../shopify/articles.js';
import {
    setMetafields,
    deleteMetafieldDefinitionIfTypeMismatch,
    ensureMetafieldDefinition,
} from '../shopify/metafields.js';

const RECIPES_PATH = 'data/recipes.json';
const BLOG_HANDLE = 'recipes';
const SGA_NAMESPACE = 'sga';
const SERVING_TIP_KEY = 'serving_tip';
const SERVING_TIP_TYPE = 'single_line_text_field';
const OWNER_TYPE = 'ARTICLE';

// Politeness: small delay between live page fetches (cache misses only).
const REQUEST_DELAY_MS = 300;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serving tip lives in the live recipe DOM as:
//   .content-block.tip-item > .tip-item__bg > .tip-item__text
// A recipe can have more than one tip block; join them into one line since the
// metafield is single_line_text_field (no newlines).
export function parseServingTip($) {
    const tips = [];
    $('.tip-item__text').each((_, element) => {
        const text = stripWhitespace($(element).text());
        if (text) tips.push(text);
    });
    return tips.join(' ');
}

async function scrapeTipForRecipe(recipe) {
    const html = await fetchHtml(recipe.sourceUrl);
    const $ = cheerio.load(html);
    return parseServingTip($);
}

function parseArgs(argv) {
    const args = { dryRun: false, limit: null, handles: null };
    for (const token of argv) {
        if (token === '--dry' || token === '--dry-run') {
            args.dryRun = true;
        } else if (token.startsWith('--limit=')) {
            args.limit = Number(token.slice('--limit='.length));
        } else if (token.startsWith('--handles=')) {
            args.handles = token.slice('--handles='.length).split(',').map((h) => h.trim()).filter(Boolean);
        }
    }
    return args;
}

async function loadRecipes() {
    const raw = await readFile(RECIPES_PATH, 'utf8');
    return JSON.parse(raw);
}

// Switch the definition from multi_line_text_field to single_line_text_field so a
// `text` setting can bind it via dynamic source. The mismatch-delete drops the old
// definition AND its (wrong) values; we then re-create and re-populate.
async function ensureSingleLineDefinition() {
    const replaced = await deleteMetafieldDefinitionIfTypeMismatch({
        ownerType: OWNER_TYPE,
        namespace: SGA_NAMESPACE,
        key: SERVING_TIP_KEY,
        expectedType: SERVING_TIP_TYPE,
    });
    await ensureMetafieldDefinition({
        name: 'Recipe serving tip',
        namespace: SGA_NAMESPACE,
        key: SERVING_TIP_KEY,
        type: SERVING_TIP_TYPE,
        ownerType: OWNER_TYPE,
        access: { storefront: 'PUBLIC_READ' },
    });
    return replaced;
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
    if (args.limit != null) {
        recipes = recipes.slice(0, args.limit);
    }

    console.log(`Re-scraping serving tips for ${recipes.length} recipe(s) (dryRun=${args.dryRun}).`);

    if (!args.dryRun) {
        const replaced = await ensureSingleLineDefinition();
        console.log(
            `serving_tip definition: ${replaced ? 'deleted multi_line + recreated as single_line_text_field' : 'already single_line_text_field (or freshly created)'}`,
        );
    }

    const scrapeLimit = pLimit(config.concurrency.scrape);
    const noTipHandles = [];
    let written = 0;
    let scraped = 0;

    await Promise.all(
        recipes.map((recipe) =>
            scrapeLimit(async () => {
                try {
                    const tip = await scrapeTipForRecipe(recipe);
                    scraped += 1;
                    if (!tip) {
                        noTipHandles.push(recipe.handle);
                    }

                    if (args.dryRun) {
                        console.log(`\n=== ${recipe.handle} ===`);
                        console.log(`    URL: ${recipe.sourceUrl}`);
                        console.log(`    tip: ${tip || '(none)'}`);
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    if (!tip) {
                        console.log(`  – ${recipe.handle}: no tip, skipping write`);
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    const article = await findArticleInBlog(BLOG_HANDLE, recipe.handle);
                    if (!article) {
                        console.error(`  ✗ ${recipe.handle}: no matching article in blog '${BLOG_HANDLE}'`);
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    await setMetafields([
                        {
                            ownerId: article.id,
                            namespace: SGA_NAMESPACE,
                            key: SERVING_TIP_KEY,
                            type: SERVING_TIP_TYPE,
                            value: tip,
                        },
                    ]);
                    written += 1;
                    console.log(`  ✓ ${recipe.handle}: wrote tip (${tip.length} chars) → ${article.id}`);
                    await delay(REQUEST_DELAY_MS);
                } catch (err) {
                    console.error(`  ✗ ${recipe.handle}: ${err.message.slice(0, 250)}`);
                }
            }),
        ),
    );

    console.log(`\nDone. scraped=${scraped} written=${written} noTip=${noTipHandles.length}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
