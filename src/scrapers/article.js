import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import {
    absolutize,
    articleHandleFromUrl,
    pathFromUrl,
    productHandleFromSourceUrl,
    stripBrandSuffix,
    stripWhitespace,
} from '../utils.js';
import { cleanContentRoot } from '../cleanHtml.js';

const ARTICLE_BODY_REMOVE = [
    'section.product-teaser',
    '.product-teaser',
    '.pimcore_area_product-slider',
];

function extractHeroExcerpt($) {
    const text = $('section.img-text-teaser--big .img-text-teaser__text, .pimcore_area_hero-teaser .img-text-teaser__text')
        .first()
        .text();
    return stripWhitespace(text);
}

function findHeroImage($, mainElement) {
    const firstImg = mainElement.find('img').first();
    if (!firstImg.length) return null;
    const candidate = firstImg.attr('data-srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
        ?? firstImg.attr('data-src')
        ?? firstImg.attr('src');
    if (!candidate || candidate.startsWith('data:')) return null;
    return {
        sourceUrl: absolutize(candidate),
        alt: stripWhitespace(firstImg.attr('alt') ?? ''),
    };
}

function extractMetaTags($) {
    const tags = new Set();
    $('main a.tag, main .tags a, main [class*="categories"] a, main [class*="tags"] a').each(
        (_, element) => {
            const tagText = stripWhitespace($(element).text());
            if (tagText) tags.add(tagText);
        },
    );
    return [...tags];
}

function extractRelatedProducts($) {
    const productsByHandle = new Map();
    $('main a[href*="/eshop/"]').each((_, element) => {
        const href = $(element).attr('href');
        if (!href) return;
        const absolute = absolutize(href);
        if (!absolute) return;
        const path = pathFromUrl(absolute);
        if (path.split('/').length < 3) return;
        const handle = productHandleFromSourceUrl(absolute);
        if (!handle) return;
        const linkText = stripWhitespace($(element).text());
        const imageElement = $(element).find('img').first();
        const imageCandidate = imageElement.attr('data-srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
            ?? imageElement.attr('data-src')
            ?? imageElement.attr('src');
        const imageUrl = imageCandidate && !imageCandidate.startsWith('data:')
            ? absolutize(imageCandidate)
            : null;
        const previous = productsByHandle.get(handle);
        if (!previous || (linkText && linkText.length > (previous.title?.length ?? 0)) || (imageUrl && !previous.imageUrl)) {
            productsByHandle.set(handle, {
                sourceHandle: handle,
                sourceUrl: absolute,
                title: linkText || previous?.title || '',
                imageUrl: imageUrl || previous?.imageUrl || null,
            });
        }
    });
    return [...productsByHandle.values()];
}

const YOU_MIGHT_ALSO_LIKE_HEADING = /Mohlo by v[áa]s tak[ée] zaj[ií]mat|Recepty, kter[ée] by v[áa]m tak[ée] mohly chutnat/i;

function isYouMightAlsoLikeSection($section) {
    const h2 = $section.find('h2').first().text();
    return YOU_MIGHT_ALSO_LIKE_HEADING.test(h2);
}

function collectArticleRefsFromSection($, $section, selfUrl) {
    const refsByHandle = new Map();
    $section.find('a[href*="/recepty-a-tipy/"]').each((_, element) => {
        const href = $(element).attr('href');
        if (!href) return;
        const absolute = absolutize(href);
        if (!absolute) return;
        if (absolute === selfUrl) return;
        const path = pathFromUrl(absolute);
        if (!path.startsWith('recepty-a-tipy/rady-a-tipy/') && !path.startsWith('recepty-a-tipy/recepty/')) return;
        const lastSegment = path.split('/').pop();
        if (!lastSegment || lastSegment === 'tag') return;
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

function extractRelatedArticles($, selfUrl) {
    // The "true" related-articles section is a polaroid slider without an h2 heading
    // — i.e. `section.page-break-avoid` whose h2 is empty (or whose h2 does NOT
    // contain the "Mohlo by vás také zajímat:" / "Recepty, které by vám…" phrase).
    const refs = new Map();
    $('section.page-break-avoid').each((_, section) => {
        const $section = $(section);
        if (isYouMightAlsoLikeSection($section)) return;
        collectArticleRefsFromSection($, $section, selfUrl).forEach((ref) => {
            if (!refs.has(ref.sourceHandle)) refs.set(ref.sourceHandle, ref);
        });
    });
    return [...refs.values()];
}

function extractYouMightAlsoLike($, selfUrl) {
    const refs = new Map();
    $('section.page-break-avoid').each((_, section) => {
        const $section = $(section);
        if (!isYouMightAlsoLikeSection($section)) return;
        collectArticleRefsFromSection($, $section, selfUrl).forEach((ref) => {
            if (!refs.has(ref.sourceHandle)) refs.set(ref.sourceHandle, ref);
        });
    });
    return [...refs.values()];
}

export async function scrapeArticle(url) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const title = stripBrandSuffix($('main h1').first().text())
        || stripBrandSuffix($('h1').first().text())
        || stripBrandSuffix($('title').text());
    const heroExcerpt = extractHeroExcerpt($);
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? '';
    const mainElement = $('main#mainContent, main.main-content, main').first();
    const heroImage = findHeroImage($, mainElement);
    const relatedProducts = extractRelatedProducts($);
    const relatedArticles = extractRelatedArticles($, url);
    const youMightAlsoLike = extractYouMightAlsoLike($, url);
    const { bodyHtml, images } = mainElement.length
        ? cleanContentRoot($, mainElement, {
            preserveStructure: true,
            additionalRemoveSelectors: ARTICLE_BODY_REMOVE,
        })
        : { bodyHtml: '', images: [] };
    const tags = extractMetaTags($);

    return {
        sourceUrl: url,
        handle: articleHandleFromUrl(url),
        title,
        metaDescription,
        heroImage,
        bodyHtml,
        images,
        tags,
        relatedProducts,
        relatedArticles,
        youMightAlsoLike,
    };
}
