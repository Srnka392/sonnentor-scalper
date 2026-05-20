import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pLimit from 'p-limit';
import { config } from './config.js';
import { upsertPage, deletePageByHandle } from './shopify/pages.js';
import { ensureBlog } from './shopify/blogs.js';
import { upsertArticle } from './shopify/articles.js';
import { setMetafields, ensureMetafieldDefinition, deleteMetafieldDefinitionIfTypeMismatch, deleteMetafieldDefinitionByKey } from './shopify/metafields.js';
import { uploadImageFromUrl } from './shopify/files.js';

const thumbnailUploadInflight = new Map();

const INGREDIENT_SECTIONS_MAX = 5;
import { resolveProduct } from './shopify/products.js';
import { slugify } from './utils.js';

const STATE_PATH = 'data/shopify-state.json';
const UNRESOLVED_PRODUCTS_CSV = 'data/unresolved-products.csv';

async function loadState() {
    try {
        const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
        state.thumbnailUploads = state.thumbnailUploads ?? {};
        return state;
    } catch {
        return { productResolutions: {}, unresolvedProducts: [], thumbnailUploads: {} };
    }
}

async function saveState(state) {
    await mkdir('data', { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function resolveProductsForItem(relatedProducts, state) {
    if (!relatedProducts?.length) return { ids: [], unresolved: [] };
    const ids = [];
    const unresolved = [];
    for (const product of relatedProducts) {
        const cacheKey = product.sourceHandle;
        const cached = state.productResolutions[cacheKey];
        if (cached?.gid) {
            ids.push(cached.gid);
            continue;
        }
        if (cached === null) {
            unresolved.push(product);
            continue;
        }
        const { product: resolved, matchedBy } = await resolveProduct({
            sourceHandle: product.sourceHandle,
            title: product.title,
        });
        if (resolved) {
            state.productResolutions[cacheKey] = {
                gid: resolved.id,
                handle: resolved.handle,
                matchedBy,
                title: resolved.title,
            };
            ids.push(resolved.id);
        } else {
            state.productResolutions[cacheKey] = null;
            unresolved.push(product);
        }
    }
    return { ids, unresolved };
}

function rewriteBodyProductUrls(bodyHtml, productResolutions) {
    if (!bodyHtml) return bodyHtml;
    return bodyHtml.replace(/\/products\/([^"'\s\\/?#]+)/g, (match, sourceSlug) => {
        const resolved = productResolutions[sourceSlug];
        if (resolved?.handle) return `/products/${resolved.handle}`;
        return match;
    });
}

async function appendUnresolvedCsv(items) {
    if (!items.length) return;
    await mkdir('data', { recursive: true });
    let existing = '';
    try {
        existing = await readFile(UNRESOLVED_PRODUCTS_CSV, 'utf8');
    } catch {
        existing = 'sourceHandle,sourceUrl,sourceTitle,referencedFrom\n';
    }
    const lines = items.map((entry) =>
        [entry.sourceHandle, entry.sourceUrl, JSON.stringify(entry.title ?? ''), entry.referencedFrom]
            .map((value) => String(value ?? '').replace(/[\n\r]/g, ' '))
            .join(','),
    );
    await writeFile(UNRESOLVED_PRODUCTS_CSV, existing + lines.join('\n') + '\n', 'utf8');
}

function wrapLegacyBody(bodyHtml) {
    if (!bodyHtml) return '';
    return `<div class="pimcore_area_content legacy-migrated">${bodyHtml}</div>`;
}

function formatIngredientItem(item, productResolutions) {
    const text = typeof item === 'string' ? item : item.text;
    if (typeof item === 'string') return text;
    const resolved = item.productSourceHandle && productResolutions[item.productSourceHandle];
    const productGid = resolved?.gid;
    if (!productGid) return text;
    const productId = productGid.split('/').pop();
    return `${text} [[${productId}]]`;
}

function buildIngredientMetafields(ownerId, ingredientGroups, productResolutions) {
    const entries = [];
    if (!Array.isArray(ingredientGroups)) return entries;
    ingredientGroups.slice(0, INGREDIENT_SECTIONS_MAX).forEach((group, index) => {
        const slot = index + 1;
        const items = (group.items || []).map((item) => formatIngredientItem(item, productResolutions));
        if (items.length) {
            entries.push({
                ownerId,
                namespace: SGA_NAMESPACE,
                key: `ingredients_${slot}`,
                type: 'list.single_line_text_field',
                value: JSON.stringify(items),
            });
        }
        if (group.section) {
            entries.push({
                ownerId,
                namespace: SGA_NAMESPACE,
                key: `ingredients_${slot}_heading`,
                type: 'single_line_text_field',
                value: group.section,
            });
        }
    });
    return entries;
}

async function ensureThumbnailFile(sourceUrl, state) {
    if (state.thumbnailUploads[sourceUrl]) return state.thumbnailUploads[sourceUrl];
    if (thumbnailUploadInflight.has(sourceUrl)) return thumbnailUploadInflight.get(sourceUrl);
    const promise = (async () => {
        try {
            const gid = await uploadImageFromUrl(sourceUrl);
            state.thumbnailUploads[sourceUrl] = gid;
            return gid;
        } finally {
            thumbnailUploadInflight.delete(sourceUrl);
        }
    })();
    thumbnailUploadInflight.set(sourceUrl, promise);
    return promise;
}

async function buildPolaroidImageMap() {
    // Polaroid teaser images appear in OTHER pages that reference this article/recipe/herb.
    // Aggregate them from every section's relatedArticles + youMightAlsoLike refs.
    const map = new Map();
    for (const file of ['data/articles.json', 'data/recipes.json', 'data/herbarium.json']) {
        try {
            const items = JSON.parse(await readFile(file, 'utf8'));
            for (const item of items) {
                for (const ref of [...(item.relatedArticles || []), ...(item.youMightAlsoLike || [])]) {
                    if (ref.imageUrl && !map.has(ref.sourceHandle)) {
                        map.set(ref.sourceHandle, ref.imageUrl);
                    }
                }
            }
        } catch {
            // File may not exist in some setups — skip silently.
        }
    }
    return map;
}

function herbBodyHtml(herb) {
    // Latin name is exposed via the `sga.latin_name` metafield — the theme renders it
    // alongside the body, so it shouldn't be prepended here.
    return herb.bodyHtml ?? '';
}

async function importPages({ dryRun, limit }) {
    const all = JSON.parse(await readFile('data/pages.json', 'utf8'));
    const items = limit ? all.slice(0, limit) : all;
    console.log(`Importing ${items.length} pages (dryRun=${dryRun})…`);
    const state = await loadState();
    const parallelLimit = pLimit(config.concurrency.import);
    let counter = { created: 0, updated: 0, failed: 0 };
    await Promise.all(
        items.map((page) =>
            parallelLimit(async () => {
                if (dryRun) {
                    console.log(`  [dry] ${page.handle} — ${page.title} (${page.bodyHtml.length} chars)`);
                    return;
                }
                try {
                    const result = await upsertPage({
                        handle: page.handle,
                        title: page.title || page.handle,
                        body: rewriteBodyProductUrls(page.bodyHtml, state.productResolutions),
                        isPublished: true,
                    });
                    if (result.created) counter.created += 1; else counter.updated += 1;
                    console.log(`  ${result.created ? '+' : '~'} ${page.handle}`);
                } catch (err) {
                    counter.failed += 1;
                    console.error(`  ✗ ${page.handle}: ${err.message.slice(0, 200)}`);
                }
            }),
        ),
    );
    console.log(`Pages: ${counter.created} created, ${counter.updated} updated, ${counter.failed} failed`);
}

const SGA_NAMESPACE = 'sga';

async function ensureMigrationMetafieldDefinitions() {
    // Drop old JSON-typed defs (with their data) before recreating with new types.
    // Why: Shopify rejects a definition create if a different-type definition already
    // owns the namespace/key. Idempotent — no-ops when the old def is absent.
    for (const oldDef of [
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'ingredients', expectedType: 'list.single_line_text_field' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'instructions', expectedType: 'list.single_line_text_field' },
    ]) {
        try {
            const dropped = await deleteMetafieldDefinitionIfTypeMismatch(oldDef);
            if (dropped) console.log(`  dropped old ${oldDef.key} definition (type mismatch)`);
        } catch (err) {
            console.error(`  drop ${oldDef.key}: ${err.message.slice(0, 200)}`);
        }
    }
    // Rename: polaroid_image_url → thumbnail. Delete the old definition unconditionally.
    try {
        const dropped = await deleteMetafieldDefinitionByKey({ ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'polaroid_image_url' });
        if (dropped) console.log('  dropped legacy polaroid_image_url definition');
    } catch (err) {
        console.error(`  drop polaroid_image_url: ${err.message.slice(0, 200)}`);
    }

    const definitions = [
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'main_product', name: 'Main product', type: 'product_reference' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'dietary', name: 'Dietary attributes', type: 'list.single_line_text_field' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'found_in_blends', name: 'Found in blends (herbarium)', type: 'list.product_reference' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'found_in_blends_heading', name: 'Found in blends heading', type: 'single_line_text_field' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'related_products', name: 'Related products', type: 'list.product_reference' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'related_products_heading', name: 'Related products heading', type: 'single_line_text_field' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'you_might_also_like_heading', name: 'You might also like heading', type: 'single_line_text_field' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'related_articles', name: 'Related articles', type: 'list.article_reference' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'you_might_also_like', name: 'You might also like', type: 'list.article_reference' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'total_time_minutes', name: 'Recipe total time (minutes)', type: 'number_integer' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'servings', name: 'Recipe servings', type: 'number_integer' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'instructions', name: 'Recipe instructions', type: 'list.single_line_text_field' },
        { ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: 'latin_name', name: 'Latin name', type: 'single_line_text_field' },
        {
            ownerType: 'ARTICLE',
            namespace: SGA_NAMESPACE,
            key: 'thumbnail',
            name: 'Thumbnail image',
            type: 'file_reference',
            validations: [{ name: 'file_type_options', value: '["Image"]' }],
        },
    ];
    for (let slot = 1; slot <= INGREDIENT_SECTIONS_MAX; slot += 1) {
        definitions.push({ ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: `ingredients_${slot}`, name: `Recipe ingredients ${slot}`, type: 'list.single_line_text_field' });
        definitions.push({ ownerType: 'ARTICLE', namespace: SGA_NAMESPACE, key: `ingredients_${slot}_heading`, name: `Recipe ingredients ${slot} heading`, type: 'single_line_text_field' });
    }
    for (const definition of definitions) {
        try {
            await ensureMetafieldDefinition(definition);
        } catch (err) {
            console.error(`  metafield def ${definition.key}: ${err.message.slice(0, 200)}`);
        }
    }
}

async function importArticlesGeneric({ section, blogHandle, blogTitle, dryRun, limit }) {
    const all = JSON.parse(await readFile(`data/${section}.json`, 'utf8'));
    const items = limit ? all.slice(0, limit) : all;
    console.log(`Importing ${items.length} ${section} → blog '${blogHandle}' (dryRun=${dryRun})…`);
    const state = await loadState();
    const polaroidMap = await buildPolaroidImageMap();
    let blogId = null;
    if (!dryRun) {
        await ensureMigrationMetafieldDefinitions();
        const blog = await ensureBlog({ handle: blogHandle, title: blogTitle });
        blogId = blog.id;
        console.log(`  blog: ${blog.handle} ${blogId}`);
    }
    const parallelLimit = pLimit(config.concurrency.import);
    const counter = { created: 0, updated: 0, failed: 0 };
    const unresolvedAccumulator = [];
    const articleHandleToGid = new Map();

    await Promise.all(
        items.map((item) =>
            parallelLimit(async () => {
                if (dryRun) {
                    console.log(`  [dry] ${item.handle} — ${item.title} (${item.relatedProducts?.length ?? 0} products, ${item.relatedArticles?.length ?? 0} articles)`);
                    return;
                }
                try {
                    const articleInput = {
                        handle: item.handle,
                        title: item.title || item.handle,
                        author: { name: 'Sonnentor' },
                        body: rewriteBodyProductUrls(wrapLegacyBody(item.bodyHtml), state.productResolutions),
                        summary: item.excerpt || item.metaDescription || '',
                        isPublished: true,
                        tags: item.tags ?? [],
                    };
                    if (item.heroImage?.sourceUrl) {
                        articleInput.image = {
                            url: item.heroImage.sourceUrl,
                            altText: item.heroImage.alt || item.title,
                        };
                    }
                    const result = await upsertArticle({ blogId, blogHandle, articlePayload: articleInput });
                    articleHandleToGid.set(item.handle, result.id);
                    const { ids: productGids, unresolved } = await resolveProductsForItem(item.relatedProducts, state);
                    unresolved.forEach((entry) =>
                        unresolvedAccumulator.push({ ...entry, referencedFrom: `article:${item.handle}` }),
                    );
                    const articleMetafields = [];
                    if (productGids.length) {
                        articleMetafields.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'related_products', type: 'list.product_reference', value: JSON.stringify(productGids) });
                    }
                    const thumbnailUrl = polaroidMap.get(item.handle);
                    if (thumbnailUrl) {
                        try {
                            const fileGid = await ensureThumbnailFile(thumbnailUrl, state);
                            articleMetafields.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'thumbnail', type: 'file_reference', value: fileGid });
                        } catch (err) {
                            console.error(`  ✗ thumbnail upload for ${item.handle}: ${err.message.slice(0, 200)}`);
                        }
                    }
                    if (articleMetafields.length) await setMetafields(articleMetafields);
                    if (result.created) counter.created += 1; else counter.updated += 1;
                    console.log(`  ${result.created ? '+' : '~'} ${item.handle} (${productGids.length}/${item.relatedProducts?.length ?? 0} products)`);
                } catch (err) {
                    counter.failed += 1;
                    console.error(`  ✗ ${item.handle}: ${err.message.slice(0, 250)}`);
                }
            }),
        ),
    );

    // Pass 2 — set related_articles & you_might_also_like now that we have a complete handle→GID map.
    let relatedArticlesSet = 0;
    let youMightSet = 0;
    if (!dryRun) {
        console.log('Pass 2: linking related_articles & you_might_also_like…');
        await Promise.all(
            items.map((item) =>
                parallelLimit(async () => {
                    const ownerGid = articleHandleToGid.get(item.handle);
                    if (!ownerGid) return;
                    const entries = [];
                    if (item.relatedArticles?.length) {
                        const gids = item.relatedArticles.map((ref) => articleHandleToGid.get(ref.sourceHandle)).filter(Boolean);
                        if (gids.length) {
                            entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'related_articles', type: 'list.article_reference', value: JSON.stringify(gids) });
                            relatedArticlesSet += 1;
                        }
                    }
                    if (item.youMightAlsoLike?.length) {
                        const gids = item.youMightAlsoLike.map((ref) => articleHandleToGid.get(ref.sourceHandle)).filter(Boolean);
                        if (gids.length) {
                            entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'you_might_also_like', type: 'list.article_reference', value: JSON.stringify(gids) });
                            youMightSet += 1;
                        }
                    }
                    if (item.youMightAlsoLikeHeading) {
                        entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'you_might_also_like_heading', type: 'single_line_text_field', value: item.youMightAlsoLikeHeading });
                    }
                    if (item.relatedProductsHeading) {
                        entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'related_products_heading', type: 'single_line_text_field', value: item.relatedProductsHeading });
                    }
                    if (!entries.length) return;
                    try { await setMetafields(entries); }
                    catch (err) { console.error(`  ✗ pass2 for ${item.handle}: ${err.message.slice(0, 200)}`); }
                }),
            ),
        );
    }

    await saveState(state);
    await appendUnresolvedCsv(unresolvedAccumulator);
    console.log(`${section}: ${counter.created} created, ${counter.updated} updated, ${counter.failed} failed. Unresolved products: ${unresolvedAccumulator.length}. Related-articles linked: ${relatedArticlesSet}. You-might-also-like linked: ${youMightSet}.`);
}


async function importRecipes({ dryRun, limit }) {
    const all = JSON.parse(await readFile('data/recipes.json', 'utf8'));
    const items = limit ? all.slice(0, limit) : all;
    console.log(`Importing ${items.length} recipes → blog 'recipes' (dryRun=${dryRun})…`);
    const state = await loadState();
    const polaroidMap = await buildPolaroidImageMap();
    let blogId = null;
    if (!dryRun) {
        await ensureMigrationMetafieldDefinitions();
        const blog = await ensureBlog({ handle: 'recipes', title: 'Recepty' });
        blogId = blog.id;
        console.log(`  blog: ${blog.handle} ${blog.id}`);
    }
    const parallelLimit = pLimit(config.concurrency.import);
    const counter = { created: 0, updated: 0, failed: 0 };
    const unresolvedAccumulator = [];
    const recipeHandleToGid = new Map();
    await Promise.all(
        items.map((recipe) =>
            parallelLimit(async () => {
                if (dryRun) {
                    console.log(`  [dry] ${recipe.handle} — ${recipe.title} (${recipe.relatedProducts?.length ?? 0} products, ${recipe.relatedArticles?.length ?? 0} recipes)`);
                    return;
                }
                try {
                    const articleInput = {
                        handle: recipe.handle,
                        title: recipe.title || recipe.handle,
                        author: { name: 'Sonnentor' },
                        body: '',
                        summary: recipe.excerpt || recipe.metaDescription || recipe.description || '',
                        isPublished: true,
                        tags: [...new Set(recipe.tags ?? [])],
                    };
                    if (recipe.heroImage?.sourceUrl) {
                        articleInput.image = { url: recipe.heroImage.sourceUrl, altText: recipe.heroImage.alt || recipe.title };
                    }
                    const result = await upsertArticle({ blogId, blogHandle: 'recipes', articlePayload: articleInput });
                    recipeHandleToGid.set(recipe.handle, result.id);
                    const mainProductRefs = recipe.mainProduct ? [recipe.mainProduct] : [];
                    const { ids: mainProductGids, unresolved: mainUnresolved } = await resolveProductsForItem(mainProductRefs, state);
                    const { ids: productGids, unresolved } = await resolveProductsForItem(recipe.relatedProducts, state);
                    unresolved.forEach((entry) =>
                        unresolvedAccumulator.push({ ...entry, referencedFrom: `recipe:${recipe.handle}` }),
                    );
                    mainUnresolved.forEach((entry) =>
                        unresolvedAccumulator.push({ ...entry, referencedFrom: `recipe:${recipe.handle}:main` }),
                    );
                    const metafieldEntries = [];
                    if (recipe.totalTimeMinutes != null) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'total_time_minutes', type: 'number_integer', value: String(recipe.totalTimeMinutes) });
                    }
                    if (recipe.servings != null) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'servings', type: 'number_integer', value: String(recipe.servings) });
                    }
                    if (recipe.ingredientGroups?.length) {
                        metafieldEntries.push(...buildIngredientMetafields(result.id, recipe.ingredientGroups, state.productResolutions));
                    }
                    if (recipe.instructions?.length) {
                        const steps = recipe.instructions.map((s) => s.text).filter(Boolean);
                        if (steps.length) {
                            metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'instructions', type: 'list.single_line_text_field', value: JSON.stringify(steps) });
                        }
                    }
                    if (mainProductGids.length) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'main_product', type: 'product_reference', value: mainProductGids[0] });
                    }
                    if (recipe.dietary?.length) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'dietary', type: 'list.single_line_text_field', value: JSON.stringify(recipe.dietary) });
                    }
                    if (productGids.length) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'related_products', type: 'list.product_reference', value: JSON.stringify(productGids) });
                    }
                    const thumbnailUrl = polaroidMap.get(recipe.handle);
                    if (thumbnailUrl) {
                        try {
                            const fileGid = await ensureThumbnailFile(thumbnailUrl, state);
                            metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'thumbnail', type: 'file_reference', value: fileGid });
                        } catch (err) {
                            console.error(`  ✗ thumbnail upload for ${recipe.handle}: ${err.message.slice(0, 200)}`);
                        }
                    }
                    if (metafieldEntries.length) await setMetafields(metafieldEntries);
                    if (result.created) counter.created += 1; else counter.updated += 1;
                    const mainStatus = mainProductGids.length ? '★' : (recipe.mainProduct ? '✗' : '–');
                    console.log(`  ${result.created ? '+' : '~'} ${recipe.handle} (main:${mainStatus} ${productGids.length}/${recipe.relatedProducts?.length ?? 0} products)`);
                } catch (err) {
                    counter.failed += 1;
                    console.error(`  ✗ ${recipe.handle}: ${err.message.slice(0, 250)}`);
                }
            }),
        ),
    );

    // Pass 2 — link related recipes via sga.related_articles & sga.you_might_also_like
    let relatedArticlesSet = 0;
    let youMightSet = 0;
    if (!dryRun) {
        console.log('Pass 2: linking related_articles & you_might_also_like (recipes)…');
        await Promise.all(
            items.map((recipe) =>
                parallelLimit(async () => {
                    const ownerGid = recipeHandleToGid.get(recipe.handle);
                    if (!ownerGid) return;
                    const entries = [];
                    if (recipe.relatedArticles?.length) {
                        const gids = recipe.relatedArticles.map((ref) => recipeHandleToGid.get(ref.sourceHandle)).filter(Boolean);
                        if (gids.length) {
                            entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'related_articles', type: 'list.article_reference', value: JSON.stringify(gids) });
                            relatedArticlesSet += 1;
                        }
                    }
                    if (recipe.youMightAlsoLike?.length) {
                        const gids = recipe.youMightAlsoLike.map((ref) => recipeHandleToGid.get(ref.sourceHandle)).filter(Boolean);
                        if (gids.length) {
                            entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'you_might_also_like', type: 'list.article_reference', value: JSON.stringify(gids) });
                            youMightSet += 1;
                        }
                    }
                    if (recipe.youMightAlsoLikeHeading) {
                        entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'you_might_also_like_heading', type: 'single_line_text_field', value: recipe.youMightAlsoLikeHeading });
                    }
                    if (recipe.relatedProductsHeading) {
                        entries.push({ ownerId: ownerGid, namespace: SGA_NAMESPACE, key: 'related_products_heading', type: 'single_line_text_field', value: recipe.relatedProductsHeading });
                    }
                    if (!entries.length) return;
                    try { await setMetafields(entries); }
                    catch (err) { console.error(`  ✗ pass2 for ${recipe.handle}: ${err.message.slice(0, 200)}`); }
                }),
            ),
        );
    }

    await saveState(state);
    await appendUnresolvedCsv(unresolvedAccumulator);
    console.log(`Recipes: ${counter.created} created, ${counter.updated} updated, ${counter.failed} failed. Unresolved products: ${unresolvedAccumulator.length}. Related-articles linked: ${relatedArticlesSet}. You-might-also-like linked: ${youMightSet}.`);
}

async function importHerbarium({ dryRun, limit }) {
    const all = JSON.parse(await readFile('data/herbarium.json', 'utf8'));
    const items = limit ? all.slice(0, limit) : all;
    console.log(`Importing ${items.length} herbs → blog 'herbarium' (dryRun=${dryRun})…`);
    const state = await loadState();
    const polaroidMap = await buildPolaroidImageMap();
    let blogId = null;
    if (!dryRun) {
        await ensureMigrationMetafieldDefinitions();
        const blog = await ensureBlog({ handle: 'herbarium', title: 'Herbář' });
        blogId = blog.id;
        console.log(`  blog: ${blog.handle} ${blog.id}`);
    }
    const parallelLimit = pLimit(config.concurrency.import);
    const counter = { created: 0, updated: 0, failed: 0 };
    const unresolvedAccumulator = [];
    await Promise.all(
        items.map((herb) =>
            parallelLimit(async () => {
                if (dryRun) {
                    console.log(`  [dry] ${herb.handle} — ${herb.title} (${herb.relatedProducts?.length ?? 0} products)`);
                    return;
                }
                try {
                    const articleInput = {
                        handle: herb.handle,
                        title: herb.title || herb.handle,
                        author: { name: 'Sonnentor' },
                        body: rewriteBodyProductUrls(wrapLegacyBody(herbBodyHtml(herb)), state.productResolutions),
                        summary: herb.excerpt || herb.metaDescription || '',
                        isPublished: true,
                        tags: [],
                    };
                    if (herb.heroImage?.sourceUrl) {
                        articleInput.image = { url: herb.heroImage.sourceUrl, altText: herb.heroImage.alt || herb.title };
                    }
                    const result = await upsertArticle({ blogId, blogHandle: 'herbarium', articlePayload: articleInput });
                    const { ids: productGids, unresolved } = await resolveProductsForItem(herb.relatedProducts, state);
                    const { ids: blendGids, unresolved: blendUnresolved } = await resolveProductsForItem(herb.foundInBlends, state);
                    unresolved.forEach((entry) =>
                        unresolvedAccumulator.push({ ...entry, referencedFrom: `herb:${herb.handle}` }),
                    );
                    blendUnresolved.forEach((entry) =>
                        unresolvedAccumulator.push({ ...entry, referencedFrom: `herb:${herb.handle}:blends` }),
                    );
                    const metafieldEntries = [];
                    if (herb.latinName) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'latin_name', type: 'single_line_text_field', value: herb.latinName });
                    }
                    if (productGids.length) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'related_products', type: 'list.product_reference', value: JSON.stringify(productGids) });
                    }
                    if (blendGids.length) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'found_in_blends', type: 'list.product_reference', value: JSON.stringify(blendGids) });
                    }
                    if (herb.foundInBlendsHeading) {
                        metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'found_in_blends_heading', type: 'single_line_text_field', value: herb.foundInBlendsHeading });
                    }
                    const thumbnailUrl = polaroidMap.get(herb.handle);
                    if (thumbnailUrl) {
                        try {
                            const fileGid = await ensureThumbnailFile(thumbnailUrl, state);
                            metafieldEntries.push({ ownerId: result.id, namespace: SGA_NAMESPACE, key: 'thumbnail', type: 'file_reference', value: fileGid });
                        } catch (err) {
                            console.error(`  ✗ thumbnail upload for ${herb.handle}: ${err.message.slice(0, 200)}`);
                        }
                    }
                    if (metafieldEntries.length) await setMetafields(metafieldEntries);
                    if (result.created) counter.created += 1; else counter.updated += 1;
                    console.log(`  ${result.created ? '+' : '~'} ${herb.handle} (related:${productGids.length}/${herb.relatedProducts?.length ?? 0} blends:${blendGids.length}/${herb.foundInBlends?.length ?? 0})`);
                } catch (err) {
                    counter.failed += 1;
                    console.error(`  ✗ ${herb.handle}: ${err.message.slice(0, 250)}`);
                }
            }),
        ),
    );
    await saveState(state);
    await appendUnresolvedCsv(unresolvedAccumulator);
    console.log(`Herbarium: ${counter.created} created, ${counter.updated} updated, ${counter.failed} failed. Unresolved products: ${unresolvedAccumulator.length}`);
}

async function deleteImportedPages({ dryRun }) {
    const all = JSON.parse(await readFile('data/pages.json', 'utf8'));
    console.log(`Deleting ${all.length} imported pages (dryRun=${dryRun})…`);
    const parallelLimit = pLimit(config.concurrency.import);
    let counter = { deleted: 0, missing: 0, failed: 0 };
    await Promise.all(
        all.map((page) =>
            parallelLimit(async () => {
                if (dryRun) {
                    console.log(`  [dry] would delete ${page.handle}`);
                    return;
                }
                try {
                    const deletedId = await deletePageByHandle(page.handle);
                    if (deletedId) {
                        counter.deleted += 1;
                        console.log(`  - ${page.handle}`);
                    } else {
                        counter.missing += 1;
                    }
                } catch (err) {
                    counter.failed += 1;
                    console.error(`  ✗ ${page.handle}: ${err.message.slice(0, 200)}`);
                }
            }),
        ),
    );
    console.log(`Pages: ${counter.deleted} deleted, ${counter.missing} not found, ${counter.failed} failed`);
}

export const sectionImporters = {
    articles: ({ dryRun, limit }) =>
        importArticlesGeneric({ section: 'articles', blogHandle: 'news', blogTitle: 'Aktuality', dryRun, limit }),
    recipes: importRecipes,
    herbarium: importHerbarium,
};

export const sectionDeleters = {
    pages: deleteImportedPages,
};
