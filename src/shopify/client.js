import { request } from 'undici';
import { requireShopifyConfig } from '../config.js';

const { store, token, apiVersion } = requireShopifyConfig();
const endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;

class ShopifyUserError extends Error {
    constructor(operationName, errors) {
        super(`${operationName} userErrors: ${JSON.stringify(errors)}`);
        this.userErrors = errors;
    }
}

async function sendGraphqlRequest(query, variables, operationName) {
    const response = await request(endpoint, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-shopify-access-token': token,
        },
        body: JSON.stringify({ query, variables, operationName }),
    });
    const body = await response.body.json();
    if (response.statusCode !== 200) {
        throw new Error(`HTTP ${response.statusCode}: ${JSON.stringify(body)}`);
    }
    if (body.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    return body;
}

const RETRYABLE_THROTTLE_CODE = 'THROTTLED';
const MAX_RETRIES = 5;

export async function shopifyGraphql(query, variables = {}, operationName = null) {
    let attempt = 0;
    while (true) {
        attempt += 1;
        const body = await sendGraphqlRequest(query, variables, operationName);
        const throttled = body.extensions?.cost?.throttleStatus;
        const restoreRate = throttled?.restoreRate ?? 50;
        const requestedCost = body.extensions?.cost?.requestedQueryCost ?? 0;
        const currentlyAvailable = throttled?.currentlyAvailable ?? 1000;
        if (currentlyAvailable < requestedCost && attempt <= MAX_RETRIES) {
            const waitMs = Math.ceil(((requestedCost - currentlyAvailable) / restoreRate) * 1000) + 200;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
        }
        if (body.errors?.some((err) => err.extensions?.code === RETRYABLE_THROTTLE_CODE) && attempt <= MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
            continue;
        }
        return body.data;
    }
}

export function assertNoUserErrors(operationName, payload) {
    const errors = payload?.userErrors;
    if (Array.isArray(errors) && errors.length > 0) {
        throw new ShopifyUserError(operationName, errors);
    }
    return payload;
}

const PING_QUERY = /* GraphQL */ `
    query Ping {
        shop {
            id
            name
            myshopifyDomain
            primaryDomain { url }
        }
    }
`;

export async function pingShop() {
    const data = await shopifyGraphql(PING_QUERY, {}, 'Ping');
    return data.shop;
}
