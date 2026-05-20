import { shopifyGraphql, assertNoUserErrors } from './client.js';

const PAGE_BY_HANDLE_QUERY = /* GraphQL */ `
    query PageByHandle($query: String!) {
        pages(first: 1, query: $query) {
            nodes { id title handle }
        }
    }
`;

const PAGE_CREATE_MUTATION = /* GraphQL */ `
    mutation CreatePage($page: PageCreateInput!) {
        pageCreate(page: $page) {
            page { id title handle }
            userErrors { code field message }
        }
    }
`;

const PAGE_UPDATE_MUTATION = /* GraphQL */ `
    mutation UpdatePage($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) {
            page { id title handle }
            userErrors { code field message }
        }
    }
`;

const PAGE_DELETE_MUTATION = /* GraphQL */ `
    mutation DeletePage($id: ID!) {
        pageDelete(id: $id) {
            deletedPageId
            userErrors { code field message }
        }
    }
`;

export async function deletePageByHandle(handle) {
    const existing = await findPageByHandle(handle);
    if (!existing) return null;
    const data = await shopifyGraphql(PAGE_DELETE_MUTATION, { id: existing.id }, 'DeletePage');
    assertNoUserErrors('pageDelete', data.pageDelete);
    return data.pageDelete.deletedPageId;
}

export async function findPageByHandle(handle) {
    const data = await shopifyGraphql(
        PAGE_BY_HANDLE_QUERY,
        { query: `handle:${handle}` },
        'PageByHandle',
    );
    return data.pages.nodes.find((node) => node.handle === handle) ?? null;
}

export async function upsertPage({ handle, title, body, isPublished = true }) {
    const existing = await findPageByHandle(handle);
    if (existing) {
        const data = await shopifyGraphql(
            PAGE_UPDATE_MUTATION,
            { id: existing.id, page: { title, body, isPublished } },
            'UpdatePage',
        );
        assertNoUserErrors('pageUpdate', data.pageUpdate);
        return { ...data.pageUpdate.page, created: false };
    }
    const data = await shopifyGraphql(
        PAGE_CREATE_MUTATION,
        { page: { title, handle, body, isPublished } },
        'CreatePage',
    );
    assertNoUserErrors('pageCreate', data.pageCreate);
    return { ...data.pageCreate.page, created: true };
}
