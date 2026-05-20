import { request } from 'undici';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';

const CACHE_DIR = 'data/raw';
const limit = pLimit(4);

function cacheKey(url) {
    return createHash('sha1').update(url).digest('hex');
}

async function fileExists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export async function fetchHtml(url, { useCache = true } = {}) {
    const cachePath = join(CACHE_DIR, `${cacheKey(url)}.html`);
    if (useCache && (await fileExists(cachePath))) {
        return readFile(cachePath, 'utf8');
    }
    return limit(async () => {
        const { statusCode, body } = await request(url, {
            maxRedirections: 5,
            headers: {
                'user-agent': 'sonnentor-migration/0.1 (+contact: michal.srnicek@gmail.com)',
                accept: 'text/html,application/xhtml+xml',
            },
        });
        if (statusCode !== 200) {
            const text = await body.text().catch(() => '');
            throw new Error(`HTTP ${statusCode} for ${url}\n${text.slice(0, 200)}`);
        }
        const html = await body.text();
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, html, 'utf8');
        return html;
    });
}

export async function fetchBinary(url) {
    return limit(async () => {
        const { statusCode, body } = await request(url, {
            maxRedirections: 5,
            headers: { 'user-agent': 'sonnentor-migration/0.1' },
        });
        if (statusCode !== 200) {
            throw new Error(`HTTP ${statusCode} for ${url}`);
        }
        return Buffer.from(await body.arrayBuffer());
    });
}
