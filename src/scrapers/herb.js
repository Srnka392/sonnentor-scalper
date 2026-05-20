import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import {
    absolutize,
    articleHandleFromUrl,
    pathFromUrl,
    productHandleFromSourceUrl,
    stripWhitespace,
} from '../utils.js';
import { cleanContentRoot } from '../cleanHtml.js';

const HERB_BODY_REMOVE = [
    'section.product-teaser',
    '.product-teaser',
    '.pimcore_area_product-slider',
    'section.product-slider',
    'section.page-break-avoid',
];

function productsFromSliderElement($, sliderElement) {
    const productsByHandle = new Map();
    $(sliderElement).find('section.product-teaser').each((_, sectionElement) => {
        const anchor = $(sectionElement).find('a[href*="/eshop/"]').first();
        if (!anchor.length) return;
        const href = anchor.attr('href');
        const absolute = absolutize(href);
        if (!absolute) return;
        const path = pathFromUrl(absolute);
        if (path.split('/').length < 3) return;
        const handle = productHandleFromSourceUrl(absolute);
        if (!handle) return;
        const title = stripWhitespace($(sectionElement).find('.product-teaser__title').first().text())
            || stripWhitespace(anchor.text());
        const imageElement = $(sectionElement).find('img').first();
        const imageCandidate = imageElement.attr('data-srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
            ?? imageElement.attr('data-src')
            ?? imageElement.attr('src');
        const imageUrl = imageCandidate && !imageCandidate.startsWith('data:')
            ? absolutize(imageCandidate)
            : null;
        const previous = productsByHandle.get(handle);
        if (!previous || (title?.length ?? 0) > (previous.title?.length ?? 0) || (imageUrl && !previous.imageUrl)) {
            productsByHandle.set(handle, {
                sourceHandle: handle,
                sourceUrl: absolute,
                title: title || previous?.title || '',
                imageUrl: imageUrl || previous?.imageUrl || null,
            });
        }
    });
    return [...productsByHandle.values()];
}

function extractHerbProductGroups($) {
    // Each herb page renders two product sliders: the first holds the herb's own
    // product (single SKU or variants), the second the "Bylinku najdete i v
    // těchto směsích / Po … voní také tyto směsi" cross-sell of blends.
    const sliders = $('main .pimcore_area_product-slider');
    const first = sliders.eq(0);
    const second = sliders.eq(1);
    const foundInBlendsHeading = second.length
        ? stripWhitespace(second.find('.content-heading h2, .content-heading h3').first().text())
            .replace(/:$/, '')
        : '';
    return {
        relatedProducts: first.length ? productsFromSliderElement($, first[0]) : [],
        foundInBlends: second.length ? productsFromSliderElement($, second[0]) : [],
        foundInBlendsHeading,
    };
}

export async function scrapeHerb(url) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const mainElement = $('main#mainContent, main.main-content, main').first();

    const title = stripWhitespace(mainElement.find('h2').first().text())
        || stripWhitespace($('h1').first().text())
        || decodeURIComponent(url.split('/').pop()).replace(/-/g, ' ');

    const latinName = stripWhitespace(
        mainElement.find('.img-text-teaser__text.wysiwyg').first().text(),
    );

    const heroImageElement = mainElement.find('img').first();
    const heroImageCandidate = heroImageElement.attr('data-srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
        ?? heroImageElement.attr('data-src')
        ?? heroImageElement.attr('src');
    const heroImage = heroImageCandidate && !heroImageCandidate.startsWith('data:')
        ? { sourceUrl: absolutize(heroImageCandidate), alt: title }
        : null;

    const { relatedProducts, foundInBlends, foundInBlendsHeading } = extractHerbProductGroups($);
    const { bodyHtml, images } = cleanContentRoot($, mainElement, {
        preserveStructure: true,
        additionalRemoveSelectors: HERB_BODY_REMOVE,
    });
    // Herb hero only contains the latin name in .img-text-teaser__text, so there is
    // no separate excerpt to scrape — fall back to metaDescription in the importer.
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? '';

    return {
        sourceUrl: url,
        handle: articleHandleFromUrl(url),
        title,
        latinName,
        metaDescription,
        bodyHtml,
        images,
        heroImage,
        relatedProducts,
        foundInBlends,
        foundInBlendsHeading,
    };
}
