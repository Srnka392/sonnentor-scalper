import { config } from './config.js';
import { fetchHtml } from './fetcher.js';
import * as cheerio from 'cheerio';

const { baseUrl, locale } = config.source;
const LOCALE_PREFIX = `/${locale}/`;

function parseSitemapLocs(xml) {
    const matches = xml.match(/<loc>([^<]+)<\/loc>/g) ?? [];
    return matches.map((match) => match.slice(5, -6).trim());
}

function localeUnderscored() {
    const [language, country] = locale.split('-');
    return `${language.toLowerCase()}_${country.toUpperCase()}`;
}

async function fetchSitemap(path) {
    const url = `${baseUrl}/${path}`;
    return parseSitemapLocs(await fetchHtml(url, { useCache: false }));
}

export async function collectArticleUrls() {
    return fetchSitemap(`sitemap.tips_${localeUnderscored()}.xml`);
}

export async function collectRecipeUrls() {
    return fetchSitemap(`sitemap.recipes_${localeUnderscored()}.xml`);
}

const EXCLUDED_STATIC_PAGE_PREFIXES = [
    'eshop',
    'recepty-a-tipy/recepty',
    'recepty-a-tipy/rady-a-tipy',
    'recepty-a-tipy/herbar',
    'recepty-a-tipy/aktualne',
    'recepty-a-tipy/slunecni-cteni',
    '_redirects',
    'jazyky',
];

const EXCLUDED_STATIC_PAGE_EXACT = new Set([
    'recepty-a-tipy',
]);

function isStaticPageUrl(url) {
    if (!url.includes(LOCALE_PREFIX)) return false;
    const path = new URL(url).pathname.replace(LOCALE_PREFIX, '').replace(/\/$/, '');
    if (!path) return false;
    if (EXCLUDED_STATIC_PAGE_EXACT.has(path)) return false;
    return !EXCLUDED_STATIC_PAGE_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
}

export async function collectStaticPageUrls() {
    const allUrls = await fetchSitemap('sitemap.default.xml');
    return allUrls.filter(isStaticPageUrl);
}

export async function collectHerbariumUrls() {
    const seenHerbUrls = new Set();
    let pageNumber = 1;
    while (true) {
        const listingUrl = `${baseUrl}${LOCALE_PREFIX}recepty-a-tipy/herbar${
            pageNumber === 1 ? '' : `?page=${pageNumber}`
        }`;
        let listingHtml;
        try {
            listingHtml = await fetchHtml(listingUrl, { useCache: false });
        } catch (err) {
            if (String(err).includes('HTTP 404')) break;
            throw err;
        }
        const $ = cheerio.load(listingHtml);
        const sizeBefore = seenHerbUrls.size;
        $('a[href*="/recepty-a-tipy/herbar/"]').each((_, element) => {
            const hrefValue = $(element).attr('href');
            if (!hrefValue) return;
            const absoluteUrl = new URL(hrefValue, baseUrl).toString();
            if (/\/herbar\/[^/?#]+$/.test(absoluteUrl)) {
                seenHerbUrls.add(absoluteUrl);
            }
        });
        if (seenHerbUrls.size === sizeBefore) break;
        pageNumber += 1;
        if (pageNumber > 20) break;
    }
    return [...seenHerbUrls];
}

export async function collectAllUrls() {
    const [pages, articles, recipes, herbarium] = await Promise.all([
        collectStaticPageUrls(),
        collectArticleUrls(),
        collectRecipeUrls(),
        collectHerbariumUrls(),
    ]);
    return { pages, articles, recipes, herbarium };
}
