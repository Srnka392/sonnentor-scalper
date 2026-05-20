import { shopifyGraphql, assertNoUserErrors } from './client.js';

const BLOG_BY_HANDLE_QUERY = /* GraphQL */ `
    query BlogByHandle($handle: String!) {
        blogs(first: 1, query: $handle) {
            nodes { id title handle }
        }
    }
`;

const BLOG_CREATE_MUTATION = /* GraphQL */ `
    mutation CreateBlog($blog: BlogCreateInput!) {
        blogCreate(blog: $blog) {
            blog { id title handle }
            userErrors { code field message }
        }
    }
`;

export async function findBlogByHandle(handle) {
    const data = await shopifyGraphql(BLOG_BY_HANDLE_QUERY, { handle: `handle:${handle}` }, 'BlogByHandle');
    const node = data.blogs.nodes.find((entry) => entry.handle === handle);
    return node ?? null;
}

export async function ensureBlog({ handle, title }) {
    const existing = await findBlogByHandle(handle);
    if (existing) return existing;
    const data = await shopifyGraphql(
        BLOG_CREATE_MUTATION,
        { blog: { title, handle } },
        'CreateBlog',
    );
    assertNoUserErrors('blogCreate', data.blogCreate);
    return data.blogCreate.blog;
}
