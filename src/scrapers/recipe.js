import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import {
    absolutize,
    articleHandleFromUrl,
    pathFromUrl,
    productHandleFromSourceUrl,
    slugify,
    stripWhitespace,
} from '../utils.js';

function extractHeroExcerpt($) {
    const text = $('section.img-text-teaser--big .img-text-teaser__text, .pimcore_area_hero-teaser .img-text-teaser__text')
        .first()
        .text();
    return stripWhitespace(text);
}

function parseJsonLdRecipe($) {
    let recipeNode = null;
    $('script[type="application/ld+json"]').each((_, element) => {
        try {
            const parsed = JSON.parse($(element).text());
            const candidates = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of candidates) {
                if (node?.['@type'] === 'Recipe') {
                    recipeNode = node;
                    return false;
                }
            }
        } catch {
            // ignore malformed JSON-LD blocks
        }
        return undefined;
    });
    return recipeNode;
}

function normalizeImageList(rawImage) {
    if (!rawImage) return [];
    if (typeof rawImage === 'string') return [rawImage];
    if (Array.isArray(rawImage)) {
        return rawImage.map((entry) => (typeof entry === 'string' ? entry : entry?.url)).filter(Boolean);
    }
    if (typeof rawImage === 'object' && rawImage.url) return [rawImage.url];
    return [];
}

function instructionsFromJsonLd(rawInstructions) {
    if (!rawInstructions) return [];
    if (typeof rawInstructions === 'string') {
        const paragraphs = rawInstructions
            .split(/<\/p>/i)
            .map((entry) => entry.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '))
            .map(stripWhitespace)
            .filter(Boolean);
        return paragraphs.map((text) => ({ section: null, text }));
    }
    if (Array.isArray(rawInstructions)) {
        const steps = [];
        let currentSection = null;
        for (const entry of rawInstructions) {
            if (!entry) continue;
            if (typeof entry === 'string') {
                steps.push({ section: currentSection, text: stripWhitespace(entry) });
            } else if (entry['@type'] === 'HowToSection') {
                currentSection = stripWhitespace(entry.name) || null;
                if (Array.isArray(entry.itemListElement)) {
                    for (const sub of entry.itemListElement) {
                        const stepText = typeof sub === 'string' ? sub : (sub?.text ?? sub?.name);
                        if (stepText) steps.push({ section: currentSection, text: stripWhitespace(stepText) });
                    }
                }
            } else if (entry['@type'] === 'HowToStep') {
                const stepText = entry.text ?? entry.name;
                if (stepText) steps.push({ section: currentSection, text: stripWhitespace(stepText) });
            } else if (entry.text) {
                steps.push({ section: currentSection, text: stripWhitespace(entry.text) });
            }
        }
        return steps;
    }
    return [];
}

function ingredientItemFromLi($, liElement) {
    const text = stripWhitespace($(liElement).text());
    if (!text) return null;
    const anchor = $(liElement).find('a[href*="/eshop/"]').first();
    if (!anchor.length) return { text };
    const href = anchor.attr('href');
    const absolute = absolutize(href);
    if (!absolute) return { text };
    const productSourceHandle = productHandleFromSourceUrl(absolute);
    if (!productSourceHandle) return { text };
    return { text, productSourceHandle };
}

function ingredientsFromHtml($) {
    const groups = [];
    const block = $('.recipe__ingredients').first();
    if (!block.length) return groups;
    const headings = block.find('.recipe__ingredients__hl');
    const lists = block.find('.recipe__ingredients__list');
    if (headings.length === lists.length && headings.length > 0) {
        headings.each((index, headingElement) => {
            const sectionName = stripWhitespace($(headingElement).text()).replace(/:$/, '');
            const listElement = lists.eq(index);
            const items = [];
            listElement.find('> li').each((_, liElement) => {
                const item = ingredientItemFromLi($, liElement);
                if (item) items.push(item);
            });
            groups.push({ section: sectionName, items });
        });
        return groups;
    }
    const flatItems = [];
    block.find('.recipe__ingredients__list > li').each((_, liElement) => {
        const item = ingredientItemFromLi($, liElement);
        if (item) flatItems.push(item);
    });
    if (flatItems.length) groups.push({ section: null, items: flatItems });
    return groups;
}

function yieldFromJsonLd(rawYield) {
    if (!rawYield) return null;
    const text = String(rawYield);
    const match = text.match(/(\d+)/);
    return match ? Number(match[1]) : null;
}

function totalTimeIso8601ToMinutes(rawValue) {
    if (!rawValue) return null;
    const match = String(rawValue).match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
    if (!match) return null;
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const total = hours * 60 + minutes;
    return total > 0 ? total : null;
}

function categoryTagsFromAll($, jsonLdNode) {
    const set = new Set();
    const rawKeywords = jsonLdNode?.keywords;
    if (Array.isArray(rawKeywords)) {
        rawKeywords.forEach((entry) => {
            if (typeof entry !== 'string') return;
            const cleaned = stripWhitespace(entry);
            if (cleaned) set.add(cleaned);
        });
    } else if (typeof rawKeywords === 'string') {
        rawKeywords.split(',').forEach((entry) => {
            const cleaned = stripWhitespace(entry);
            if (cleaned) set.add(cleaned);
        });
    }
    $('.recipe__categories__item.badge, [class*="recipe__categories__item"]').each(
        (_, element) => {
            const tagText = stripWhitespace($(element).text());
            if (tagText) set.add(tagText);
        },
    );
    return [...set];
}

function dietaryAttributesFromHtml($) {
    const set = new Set();
    $('ul.recipe__tags > li.recipe__tags__item').each((_, element) => {
        const text = stripWhitespace($(element).text());
        if (text) set.add(text);
    });
    return [...set];
}

const YOU_MIGHT_ALSO_LIKE_HEADING = /Mohlo by v[áa]s tak[ée] zaj[ií]mat|Recepty, kter[ée] by v[áa]m tak[ée] mohly chutnat/i;

function isYouMightAlsoLikeSection($section) {
    const h2 = $section.find('h2').first().text();
    return YOU_MIGHT_ALSO_LIKE_HEADING.test(h2);
}

function collectRecipeRefsFromSection($, $section, selfUrl) {
    const refsByHandle = new Map();
    $section.find('a[href*="/recepty-a-tipy/"]').each((_, element) => {
        const href = $(element).attr('href');
        if (!href) return;
        const absolute = absolutize(href);
        if (!absolute) return;
        if (absolute === selfUrl) return;
        const path = pathFromUrl(absolute);
        if (!path.startsWith('recepty-a-tipy/recepty/') && !path.startsWith('recepty-a-tipy/rady-a-tipy/')) return;
        const lastSegment = path.split('/').pop();
        if (!lastSegment) return;
        const segments = path.split('/');
        if (segments.length < 3) return;
        const linkText = stripWhitespace($(element).text());
        const previous = refsByHandle.get(lastSegment);
        if (!previous || (linkText && linkText.length > (previous.title?.length ?? 0))) {
            refsByHandle.set(lastSegment, {
                sourceHandle: lastSegment,
                sourceUrl: absolute,
                title: linkText || previous?.title || '',
            });
        }
    });
    return [...refsByHandle.values()];
}

function extractRelatedRecipes($, selfUrl) {
    const refs = new Map();
    $('section.page-break-avoid').each((_, section) => {
        const $section = $(section);
        if (isYouMightAlsoLikeSection($section)) return;
        collectRecipeRefsFromSection($, $section, selfUrl).forEach((ref) => {
            if (!refs.has(ref.sourceHandle)) refs.set(ref.sourceHandle, ref);
        });
    });
    return [...refs.values()];
}

function extractYouMightAlsoLikeRecipes($, selfUrl) {
    const refs = new Map();
    $('section.page-break-avoid').each((_, section) => {
        const $section = $(section);
        if (!isYouMightAlsoLikeSection($section)) return;
        collectRecipeRefsFromSection($, $section, selfUrl).forEach((ref) => {
            if (!refs.has(ref.sourceHandle)) refs.set(ref.sourceHandle, ref);
        });
    });
    return [...refs.values()];
}

function extractYouMightAlsoLikeHeading($) {
    let heading = '';
    $('section.page-break-avoid').each((_, section) => {
        const $section = $(section);
        if (!isYouMightAlsoLikeSection($section)) return;
        const text = stripWhitespace($section.find('h2').first().text()).replace(/:$/, '');
        if (text) heading = text;
        return false;
    });
    return heading;
}

function productFromTeaserSection($, sectionElement) {
    const anchor = $(sectionElement).find('a[href*="/eshop/"]').first();
    if (!anchor.length) return null;
    const href = anchor.attr('href');
    const absolute = absolutize(href);
    if (!absolute) return null;
    const path = pathFromUrl(absolute);
    if (path.split('/').length < 3) return null;
    const handle = productHandleFromSourceUrl(absolute);
    if (!handle) return null;
    const title = stripWhitespace($(sectionElement).find('.product-teaser__title').first().text())
        || stripWhitespace(anchor.text());
    const imageElement = $(sectionElement).find('img').first();
    const imageCandidate = imageElement.attr('data-srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
        ?? imageElement.attr('data-src')
        ?? imageElement.attr('src');
    const imageUrl = imageCandidate && !imageCandidate.startsWith('data:')
        ? absolutize(imageCandidate)
        : null;
    return { sourceHandle: handle, sourceUrl: absolute, title, imageUrl };
}

function extractMainProduct($) {
    const aside = $('section.product-teaser.product-teaser--aside').first();
    if (!aside.length) return null;
    return productFromTeaserSection($, aside);
}

function extractRelatedProducts($) {
    const productsByHandle = new Map();
    // "Další naše produkty k receptu:" is rendered in `section.content-block.product-slider`
    // (recipes) or in the `.pimcore_area_product-slider` block (herbs, articles).
    const sliderSections = $('section.product-slider, .pimcore_area_product-slider');
    sliderSections.find('section.product-teaser').each((_, sectionElement) => {
        const product = productFromTeaserSection($, sectionElement);
        if (!product) return;
        const previous = productsByHandle.get(product.sourceHandle);
        if (!previous || (product.title?.length ?? 0) > (previous.title?.length ?? 0) || (product.imageUrl && !previous.imageUrl)) {
            productsByHandle.set(product.sourceHandle, product);
        }
    });
    return [...productsByHandle.values()];
}

function findHeroImage($, mainElement, jsonLdImages) {
    if (jsonLdImages.length) {
        const candidate = jsonLdImages[0];
        const absoluteUrl = absolutize(candidate);
        if (absoluteUrl && !absoluteUrl.startsWith('data:')) {
            return { sourceUrl: absoluteUrl, alt: '' };
        }
    }
    const firstImg = mainElement.find('img').first();
    if (!firstImg.length) return null;
    const candidate = firstImg.attr('data-srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
        ?? firstImg.attr('data-src')
        ?? firstImg.attr('src');
    if (!candidate || candidate.startsWith('data:')) return null;
    return { sourceUrl: absolutize(candidate), alt: stripWhitespace(firstImg.attr('alt') ?? '') };
}

export async function scrapeRecipe(url) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const recipeNode = parseJsonLdRecipe($);
    const mainElement = $('main#mainContent, main.main-content, main').first();

    const title = stripWhitespace(recipeNode?.name)
        || stripWhitespace(mainElement.find('h1').first().text())
        || stripWhitespace($('title').text());
    const description = stripWhitespace(recipeNode?.description);
    const totalTimeMinutes = totalTimeIso8601ToMinutes(recipeNode?.totalTime);
    const servings = yieldFromJsonLd(recipeNode?.recipeYield);
    const ingredientGroups = ingredientsFromHtml($);
    const instructions = instructionsFromJsonLd(recipeNode?.recipeInstructions);
    const tags = categoryTagsFromAll($, recipeNode);
    const dietary = dietaryAttributesFromHtml($);
    const jsonLdImages = normalizeImageList(recipeNode?.image);
    const heroImage = findHeroImage($, mainElement, jsonLdImages);
    const mainProduct = extractMainProduct($);
    const relatedProducts = extractRelatedProducts($);
    const relatedArticles = extractRelatedRecipes($, url);
    const youMightAlsoLike = extractYouMightAlsoLikeRecipes($, url);
    const youMightAlsoLikeHeading = extractYouMightAlsoLikeHeading($);
    const heroExcerpt = extractHeroExcerpt($);
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? description;
    const rating = recipeNode?.aggregateRating
        ? {
            value: Number(recipeNode.aggregateRating.ratingValue) || null,
            count: Number(recipeNode.aggregateRating.reviewCount) || null,
        }
        : null;

    return {
        sourceUrl: url,
        handle: articleHandleFromUrl(url),
        title,
        excerpt: heroExcerpt,
        metaDescription,
        description,
        totalTimeMinutes,
        servings,
        ingredientGroups,
        instructions,
        tags,
        tagSlugs: tags.map(slugify),
        dietary,
        heroImage,
        mainProduct,
        relatedProducts,
        relatedArticles,
        youMightAlsoLike,
        youMightAlsoLikeHeading,
        rating,
    };
}
