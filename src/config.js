import 'dotenv/config';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

export const config = {
    source: {
        baseUrl: process.env.SOURCE_BASE_URL ?? 'https://www.sonnentor.com',
        locale: process.env.SOURCE_LOCALE ?? 'cs-cz',
    },
    shopify: {
        store: process.env.SHOPIFY_STORE,
        token: process.env.SHOPIFY_ADMIN_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION ?? '2025-10',
    },
    concurrency: {
        scrape: Number(process.env.SCRAPE_CONCURRENCY ?? 4),
        import: Number(process.env.IMPORT_CONCURRENCY ?? 2),
    },
};

export function requireShopifyConfig() {
    if (!config.shopify.store) throw new Error('Missing SHOPIFY_STORE in .env');
    if (!config.shopify.token) throw new Error('Missing SHOPIFY_ADMIN_TOKEN in .env');
    return config.shopify;
}
