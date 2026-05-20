import { shopifyGraphql } from './client.js';

const PRODUCT_BY_HANDLE_QUERY = /* GraphQL */ `
    query ProductByHandle($handle: String!) {
        productByIdentifier(identifier: { handle: $handle }) {
            id
            title
            handle
        }
    }
`;

const PRODUCT_SEARCH_QUERY = /* GraphQL */ `
    query ProductSearch($query: String!) {
        products(first: 3, query: $query) {
            nodes { id title handle }
        }
    }
`;

export async function findProductByHandle(handle) {
    try {
        const data = await shopifyGraphql(PRODUCT_BY_HANDLE_QUERY, { handle }, 'ProductByHandle');
        return data.productByIdentifier ?? null;
    } catch {
        return null;
    }
}

export async function searchProductByTitle(title) {
    if (!title) return null;
    const sanitized = title.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sanitized) return null;
    const data = await shopifyGraphql(
        PRODUCT_SEARCH_QUERY,
        { query: `title:${sanitized}` },
        'ProductSearch',
    );
    return data.products.nodes[0] ?? null;
}

export async function resolveProduct({ sourceHandle, title }) {
    if (sourceHandle) {
        const byHandle = await findProductByHandle(sourceHandle);
        if (byHandle) return { product: byHandle, matchedBy: 'handle' };
    }
    if (title) {
        const byTitle = await searchProductByTitle(title);
        if (byTitle) return { product: byTitle, matchedBy: 'title' };
    }
    return { product: null, matchedBy: null };
}
