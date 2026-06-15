import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { fetchHtml } from '../fetcher.js';
import { stripWhitespace } from '../utils.js';
import { config } from '../config.js';
import { findArticleInBlog } from '../shopify/articles.js';
import { setMetafields } from '../shopify/metafields.js';

const RECIPES_PATH = 'data/recipes.json';
const BLOG_HANDLE = 'recipes';
const SGA_NAMESPACE = 'sga';
const INSTRUCTIONS_KEY = 'instructions';
const INSTRUCTIONS_TYPE = 'list.single_line_text_field';

// Politeness: small delay between live page fetches (cache misses only).
const REQUEST_DELAY_MS = 300;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse the preparation steps from the live recipe DOM:
//   .container-narrow.wysiwyg > ol.preparation-steps > li > .preparation-steps__item
// There can be multiple `ol.preparation-steps` blocks and multiple `<li>` per ol.
// Each `.preparation-steps__item` (document order, across all ol blocks) = one step.
// cheerio's .text() already decodes HTML entities; stripWhitespace collapses whitespace.
export function parsePreparationSteps($) {
    const steps = [];
    $('.preparation-steps__item').each((_, element) => {
        const text = stripWhitespace($(element).text());
        if (text) steps.push(text);
    });
    return steps;
}

async function scrapeStepsForRecipe(recipe) {
    const html = await fetchHtml(recipe.sourceUrl);
    const $ = cheerio.load(html);
    return parsePreparationSteps($);
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

    console.log(`Re-scraping preparation steps for ${recipes.length} recipe(s) (dryRun=${args.dryRun}).`);

    const scrapeLimit = pLimit(config.concurrency.scrape);
    const zeroStepHandles = [];
    let written = 0;
    let scraped = 0;

    await Promise.all(
        recipes.map((recipe) =>
            scrapeLimit(async () => {
                try {
                    const steps = await scrapeStepsForRecipe(recipe);
                    scraped += 1;
                    if (!steps.length) {
                        zeroStepHandles.push(recipe.handle);
                    }

                    if (args.dryRun) {
                        console.log(`\n=== ${recipe.handle} (${steps.length} steps) ===`);
                        console.log(`    URL: ${recipe.sourceUrl}`);
                        steps.forEach((step, index) => {
                            console.log(`    [${index + 1}] ${step}`);
                        });
                        console.log(`    JSON value: ${JSON.stringify(steps)}`);
                        await delay(REQUEST_DELAY_MS);
                        return;
                    }

                    if (!steps.length) {
                        console.log(`  – ${recipe.handle}: 0 steps, skipping write`);
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
                            key: INSTRUCTIONS_KEY,
                            type: INSTRUCTIONS_TYPE,
                            value: JSON.stringify(steps),
                        },
                    ]);
                    written += 1;
                    console.log(`  ✓ ${recipe.handle}: wrote ${steps.length} steps → ${article.id}`);
                    await delay(REQUEST_DELAY_MS);
                } catch (err) {
                    console.error(`  ✗ ${recipe.handle}: ${err.message.slice(0, 250)}`);
                }
            }),
        ),
    );

    console.log(`\nDone. scraped=${scraped} written=${written} zeroStep=${zeroStepHandles.length}`);
    if (zeroStepHandles.length) {
        console.log(`Zero-step handles:\n${zeroStepHandles.map((h) => `  - ${h}`).join('\n')}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
