import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import { pageHandleFromUrl, stripBrandSuffix } from '../utils.js';
import { cleanContentRoot } from '../cleanHtml.js';

export async function scrapePage(url) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const title = stripBrandSuffix($('main h1').first().text())
        || stripBrandSuffix($('h1').first().text())
        || stripBrandSuffix($('title').first().text());

    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? '';

    const mainElement = $('main#mainContent, main.main-content, main').first();
    const { bodyHtml, images } = mainElement.length
        ? cleanContentRoot($, mainElement, { preserveStructure: true })
        : { bodyHtml: '', images: [] };

    return {
        sourceUrl: url,
        handle: pageHandleFromUrl(url),
        title,
        metaDescription,
        bodyHtml,
        images,
    };
}
