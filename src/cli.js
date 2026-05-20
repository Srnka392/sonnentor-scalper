import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { collectAllUrls } from './sourceUrls.js';
import { scrapePage } from './scrapers/page.js';
import { scrapeArticle } from './scrapers/article.js';
import { scrapeRecipe } from './scrapers/recipe.js';
import { scrapeHerb } from './scrapers/herb.js';
import { config } from './config.js';

const [, , command, ...args] = process.argv;

async function runUrls() {
    const inventory = await collectAllUrls();
    const summary = Object.fromEntries(
        Object.entries(inventory).map(([key, value]) => [key, value.length]),
    );
    console.log('URL inventory:', summary);
    await mkdir('data', { recursive: true });
    await writeFile('data/urls.json', JSON.stringify(inventory, null, 2), 'utf8');
    console.log('Wrote data/urls.json');
}

const SCRAPER_BY_SECTION = {
    pages: { scraper: scrapePage, urlKey: 'pages', output: 'data/pages.json' },
    articles: { scraper: scrapeArticle, urlKey: 'articles', output: 'data/articles.json' },
    recipes: { scraper: scrapeRecipe, urlKey: 'recipes', output: 'data/recipes.json' },
    herbarium: { scraper: scrapeHerb, urlKey: 'herbarium', output: 'data/herbarium.json' },
};

async function runScrape([section, ...rest]) {
    if (!section) throw new Error('Usage: scrape <pages|articles|recipes|herbarium> [--limit N]');
    const config_ = SCRAPER_BY_SECTION[section];
    if (!config_) throw new Error(`Unknown section: ${section}. Implemented: ${Object.keys(SCRAPER_BY_SECTION).join(', ')}`);

    const limitArgIndex = rest.indexOf('--limit');
    const limitCount = limitArgIndex >= 0 ? Number(rest[limitArgIndex + 1]) : null;

    const inventoryRaw = await readFile('data/urls.json', 'utf8');
    const inventory = JSON.parse(inventoryRaw);
    let urls = inventory[config_.urlKey] ?? [];
    if (limitCount) urls = urls.slice(0, limitCount);

    console.log(`Scraping ${urls.length} ${section}…`);
    const parallelLimit = pLimit(config.concurrency.scrape);
    let completedCount = 0;
    const results = await Promise.all(
        urls.map((url) =>
            parallelLimit(async () => {
                try {
                    const data = await config_.scraper(url);
                    completedCount += 1;
                    if (completedCount % 25 === 0 || completedCount === urls.length) {
                        console.log(`  ${completedCount}/${urls.length}`);
                    }
                    return { ok: true, data };
                } catch (err) {
                    console.error(`  FAILED: ${url}\n    ${err.message}`);
                    return { ok: false, sourceUrl: url, error: err.message };
                }
            }),
        ),
    );

    const successful = results.filter((r) => r.ok).map((r) => r.data);
    const failed = results.filter((r) => !r.ok);
    await mkdir('data', { recursive: true });
    await writeFile(config_.output, JSON.stringify(successful, null, 2), 'utf8');
    if (failed.length) {
        await writeFile(`data/${section}-errors.json`, JSON.stringify(failed, null, 2), 'utf8');
    }
    console.log(`Wrote ${config_.output} — ${successful.length} ok, ${failed.length} failed`);
}

async function runPing() {
    const { pingShop } = await import('./shopify/client.js');
    const shop = await pingShop();
    console.log('Connected to Shopify:');
    console.log('  id:           ', shop.id);
    console.log('  name:         ', shop.name);
    console.log('  myshopify:    ', shop.myshopifyDomain);
    console.log('  primaryDomain:', shop.primaryDomain?.url);
}

async function runImport([section, ...rest]) {
    if (!section) throw new Error('Usage: import <pages|articles|recipes|herbarium> [--dry] [--limit N]');
    const { sectionImporters } = await import('./importer.js');
    const importerFn = sectionImporters[section];
    if (!importerFn) throw new Error(`Unknown section: ${section}`);
    const dryRun = rest.includes('--dry');
    const limitArgIndex = rest.indexOf('--limit');
    const limitCount = limitArgIndex >= 0 ? Number(rest[limitArgIndex + 1]) : null;
    await importerFn({ dryRun, limit: limitCount });
}

async function runDelete([section, ...rest]) {
    if (!section) throw new Error('Usage: delete <pages> [--dry]');
    const { sectionDeleters } = await import('./importer.js');
    const deleterFn = sectionDeleters[section];
    if (!deleterFn) throw new Error(`Unknown section: ${section} (available: ${Object.keys(sectionDeleters).join(', ')})`);
    const dryRun = rest.includes('--dry');
    await deleterFn({ dryRun });
}

const commands = {
    urls: runUrls,
    scrape: runScrape,
    ping: runPing,
    import: runImport,
    delete: runDelete,
};

const handler = commands[command];
if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(`Available: ${Object.keys(commands).join(', ')}`);
    process.exit(1);
}

handler(args).catch((err) => {
    console.error(err);
    process.exit(1);
});
