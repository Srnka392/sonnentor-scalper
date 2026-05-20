import { config } from './config.js';

const { baseUrl, locale } = config.source;
const LOCALE_PREFIX = `/${locale}/`;

export function pathFromUrl(url) {
    return new URL(url).pathname.replace(LOCALE_PREFIX, '').replace(/\/$/, '');
}

export function slugify(text) {
    return text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function safeDecodeUriComponent(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

export function pageHandleFromUrl(url) {
    const path = pathFromUrl(url);
    return slugify(safeDecodeUriComponent(path).replace(/\//g, '-'));
}

export function articleHandleFromUrl(url) {
    const path = pathFromUrl(url);
    const last = path.split('/').pop() ?? '';
    return slugify(safeDecodeUriComponent(last));
}

export function absolutize(srcOrHref) {
    if (!srcOrHref) return null;
    try {
        return new URL(srcOrHref, baseUrl).toString();
    } catch {
        return null;
    }
}

export function productHandleFromSourceUrl(productUrl) {
    const path = pathFromUrl(productUrl);
    if (!path.startsWith('eshop/')) return null;
    const lastSegment = path.split('/').pop();
    return lastSegment ? slugify(lastSegment) : null;
}

export function stripWhitespace(text) {
    if (text == null) return '';
    return String(text).replace(/\s+/g, ' ').trim();
}

const BRAND_SUFFIX_PATTERN = /\s*[-–|]\s*SONNENTOR(?:\.com)?\s*$/i;
export function stripBrandSuffix(text) {
    if (!text) return '';
    return stripWhitespace(text).replace(BRAND_SUFFIX_PATTERN, '');
}
