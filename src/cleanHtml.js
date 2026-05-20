import { absolutize, slugify, stripWhitespace } from './utils.js';
import { config } from './config.js';

const SOURCE_BASE_URL = config.source.baseUrl;
const SOURCE_LOCALE_PREFIX = `/${config.source.locale}/`;

function safeDecodeUriComponent(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

function rewriteSourceLink(absoluteUrl) {
    if (!absoluteUrl) return absoluteUrl;
    let parsedUrl;
    try { parsedUrl = new URL(absoluteUrl); } catch { return absoluteUrl; }
    if (parsedUrl.origin !== SOURCE_BASE_URL) return absoluteUrl;
    if (!parsedUrl.pathname.startsWith(SOURCE_LOCALE_PREFIX)) return absoluteUrl;
    const relativePath = parsedUrl.pathname.slice(SOURCE_LOCALE_PREFIX.length).replace(/\/$/, '');
    if (!relativePath) return '/';
    if (relativePath.startsWith('recepty-a-tipy/rady-a-tipy/')) {
        const slug = slugify(safeDecodeUriComponent(relativePath.split('/').pop()));
        return slug ? `/blogs/news/${slug}` : null;
    }
    if (relativePath.startsWith('recepty-a-tipy/recepty/')) {
        const slug = slugify(safeDecodeUriComponent(relativePath.split('/').pop()));
        return slug ? `/blogs/recipes/${slug}` : null;
    }
    if (relativePath.startsWith('recepty-a-tipy/herbar/')) {
        const slug = slugify(safeDecodeUriComponent(relativePath.split('/').pop()));
        return slug ? `/blogs/herbarium/${slug}` : null;
    }
    if (relativePath.startsWith('eshop/')) {
        const lastSegment = relativePath.split('/').pop();
        if (!lastSegment) return null;
        const slug = slugify(safeDecodeUriComponent(lastSegment));
        return `/products/${slug}`;
    }
    const flattenedSlug = slugify(safeDecodeUriComponent(relativePath.replace(/\//g, '-')));
    return flattenedSlug ? `/pages/${flattenedSlug}` : '/';
}

const STRUCTURAL_ATTRIBUTE_ALLOWLIST = new Set(['class', 'id']);

const SEMANTIC_BLOCK_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'figure', 'figcaption',
    'iframe',
]);

const SEMANTIC_INLINE_TAGS = new Set([
    'a', 'strong', 'b', 'em', 'i', 'u', 'span', 'br', 'sup', 'sub', 'code', 'mark',
]);

const REMOVE_SELECTORS = [
    'script', 'noscript', 'style', 'svg',
    '[aria-hidden="true"]',
    '.breadcrumb', '.breadcrumbs', '.pimcore_area_breadcrumb',
    '.share', '.social-share', '.js-share',
    'form', 'input', 'button',
    '.cookie', '.cookies',
    '.recommendations', '.related', '.product-recommendations',
    '.recipe-rating', '.rating',
    'nav',
    '[data-template]',
    '.pimcore_area_hero-teaser',
    '.img-text-teaser--big',
    '.pimcore_area_gallery',
    '.pimcore_area_contact-person',
    '.breadcrumb-wrapper',
    '.article-nav-link',
    '.tip-meta',
    '.d-print-none',
    '.product-information__categories',
    'section.page-break-avoid',
];

const HEADING_ONLY_WYSIWYG_PHRASES = [
    /inspirujte se v galerii/i,
    /pro bli[žz][šs][íi] informace kontaktujte/i,
];

const ALLOWED_LINK_ATTRS = new Set(['href', 'title', 'target', 'rel', 'class']);
const ALLOWED_IMG_ATTRS = new Set(['src', 'alt', 'title', 'width', 'height', 'class']);

function resolveImageSource($, element) {
    const dataSrcset = $(element).attr('data-srcset');
    if (dataSrcset) {
        const firstSrc = dataSrcset.split(',')[0]?.trim().split(/\s+/)[0];
        if (firstSrc && !firstSrc.startsWith('data:')) return firstSrc;
    }
    const dataSrc = $(element).attr('data-src');
    if (dataSrc && !dataSrc.startsWith('data:')) return dataSrc;
    const src = $(element).attr('src');
    if (src && !src.startsWith('data:')) return src;
    return null;
}

function stripAttributesExcept($, element, allowedSet) {
    const attribs = element.attribs ?? {};
    Object.keys(attribs).forEach((attributeName) => {
        if (!allowedSet.has(attributeName)) {
            $(element).removeAttr(attributeName);
        }
    });
}

function processImages($, root) {
    const collected = [];
    root.find('img').each((_, imgElement) => {
        const resolvedSrc = resolveImageSource($, imgElement);
        if (!resolvedSrc) {
            $(imgElement).remove();
            return;
        }
        const absoluteUrl = absolutize(resolvedSrc);
        if (!absoluteUrl) {
            $(imgElement).remove();
            return;
        }
        const altText = stripWhitespace($(imgElement).attr('alt') ?? '');
        collected.push({ sourceUrl: absoluteUrl, alt: altText });
        $(imgElement).attr('src', absoluteUrl);
        $(imgElement).attr('alt', altText);
        stripAttributesExcept($, imgElement, ALLOWED_IMG_ATTRS);
    });
    // <picture> wrapping is decorative — unwrap so only <img> remains
    root.find('picture').each((_, pictureElement) => {
        $(pictureElement).find('source').remove();
        const innerHtml = $(pictureElement).html() ?? '';
        $(pictureElement).replaceWith(innerHtml);
    });
    return collected;
}

function processLinks($, root) {
    root.find('a').each((_, anchorElement) => {
        const hrefValue = $(anchorElement).attr('href');
        // Drop tag/filter anchors with query strings — they carried internal Pimcore topic ids.
        if (hrefValue && /\/tag\?topic=/.test(hrefValue)) {
            const innerHtml = $(anchorElement).html() ?? '';
            $(anchorElement).replaceWith(innerHtml);
            return;
        }
        const absoluteHref = absolutize(hrefValue);
        const rewrittenHref = rewriteSourceLink(absoluteHref) ?? absoluteHref;
        if (rewrittenHref === null) {
            const innerHtml = $(anchorElement).html() ?? '';
            $(anchorElement).replaceWith(innerHtml);
            return;
        }
        if (rewrittenHref) {
            $(anchorElement).attr('href', rewrittenHref);
        }
        stripAttributesExcept($, anchorElement, ALLOWED_LINK_ATTRS);
    });
}

function unwrapNonSemanticWrappers($, root) {
    let iterations = 0;
    let changed = true;
    while (changed && iterations < 10) {
        changed = false;
        iterations += 1;
        root.find('div, section, article, header, footer, aside, span').each((_, element) => {
            const tagName = element.tagName?.toLowerCase();
            if (!tagName) return;
            if (SEMANTIC_BLOCK_TAGS.has(tagName) || SEMANTIC_INLINE_TAGS.has(tagName)) return;
            const innerHtml = $(element).html();
            if (innerHtml === null) return;
            $(element).replaceWith(innerHtml);
            changed = true;
        });
    }
}

function stripAllAttributes($, root) {
    root.find('*').each((_, element) => {
        const tagName = element.tagName?.toLowerCase();
        if (tagName === 'a') return;
        if (tagName === 'img') return;
        if (!element.attribs) return;
        Object.keys(element.attribs).forEach((attributeName) => {
            $(element).removeAttr(attributeName);
        });
    });
}

function collapseEmptyElements($, root) {
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 5) {
        changed = false;
        iterations += 1;
        root.find('p, span, li, ul, ol').each((_, element) => {
            const textValue = stripWhitespace($(element).text());
            const hasMedia = $(element).find('img, iframe').length > 0;
            if (!textValue && !hasMedia) {
                $(element).remove();
                changed = true;
            }
        });
    }
}

function compactWhitespaceTextNodes($, root) {
    root.find('*').contents().each((_, node) => {
        if (node.type === 'text') {
            const compactValue = node.data.replace(/\s+/g, ' ');
            node.data = compactValue;
        }
    });
}

function removeCommentNodes($, root) {
    root.find('*').contents().each((_, node) => {
        if (node.type === 'comment') $(node).remove();
    });
    // top-level comments
    root.contents().each((_, node) => {
        if (node.type === 'comment') $(node).remove();
    });
}

function minifyHtmlString(html) {
    return html
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();
}

function stripAttributesPreserveStructure($, root) {
    root.find('*').each((_, element) => {
        const tagName = element.tagName?.toLowerCase();
        if (tagName === 'a') return;
        if (tagName === 'img') return;
        if (!element.attribs) return;
        Object.keys(element.attribs).forEach((attributeName) => {
            if (STRUCTURAL_ATTRIBUTE_ALLOWLIST.has(attributeName)) return;
            $(element).removeAttr(attributeName);
        });
    });
}

function removeHeadingOnlyWysiwygBlocks($, root) {
    root.find('.pimcore_area_wysiwyg').each((_, block) => {
        const text = $(block).text().replace(/\s+/g, ' ').trim();
        if (!text) return;
        if (text.length > 100) return;
        if (HEADING_ONLY_WYSIWYG_PHRASES.some((pattern) => pattern.test(text))) {
            $(block).remove();
            return;
        }
        // Heuristic: short wysiwyg whose text ends with a colon and contains a heading
        // element is almost always a section divider whose payload (product teaser, gallery,
        // contact card) has already been stripped. Remove the orphan heading.
        if (text.endsWith(':') && $(block).find('h1, h2, h3, h4, h5, h6').length > 0) {
            $(block).remove();
        }
    });
}

export function cleanContentRoot($, contentRoot, {
    preserveStructure = false,
    additionalRemoveSelectors = [],
} = {}) {
    const workingRoot = contentRoot.clone();
    [...REMOVE_SELECTORS, ...additionalRemoveSelectors].forEach((selector) =>
        workingRoot.find(selector).remove(),
    );
    removeHeadingOnlyWysiwygBlocks($, workingRoot);
    removeCommentNodes($, workingRoot);
    const images = processImages($, workingRoot);
    processLinks($, workingRoot);
    if (preserveStructure) {
        stripAttributesPreserveStructure($, workingRoot);
    } else {
        unwrapNonSemanticWrappers($, workingRoot);
        stripAllAttributes($, workingRoot);
    }
    collapseEmptyElements($, workingRoot);
    compactWhitespaceTextNodes($, workingRoot);
    const rawHtml = (workingRoot.html() ?? '').trim();
    const bodyHtml = minifyHtmlString(rawHtml);
    return { bodyHtml, images };
}
