import { shopifyGraphql, assertNoUserErrors } from './client.js';

const ARTICLE_BY_HANDLE_QUERY = /* GraphQL */ `
    query ArticleByHandle($query: String!) {
        articles(first: 5, query: $query) {
            nodes { id title handle blog { id handle } }
        }
    }
`;

const ARTICLE_CREATE_MUTATION = /* GraphQL */ `
    mutation CreateArticle($article: ArticleCreateInput!) {
        articleCreate(article: $article) {
            article { id title handle }
            userErrors { code field message }
        }
    }
`;

const ARTICLE_UPDATE_MUTATION = /* GraphQL */ `
    mutation UpdateArticle($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) {
            article { id title handle }
            userErrors { code field message }
        }
    }
`;

export async function findArticleInBlog(blogHandle, articleHandle) {
    const data = await shopifyGraphql(
        ARTICLE_BY_HANDLE_QUERY,
        { query: `handle:${articleHandle}` },
        'ArticleByHandle',
    );
    return (
        data.articles.nodes.find(
            (node) => node.handle === articleHandle && node.blog?.handle === blogHandle,
        ) ?? null
    );
}

export async function upsertArticle({ blogId, blogHandle, articlePayload }) {
    const existing = await findArticleInBlog(blogHandle, articlePayload.handle);
    if (existing) {
        const { blogId: _ignoredBlogId, handle: _ignoredHandle, ...updatable } = articlePayload;
        const data = await shopifyGraphql(
            ARTICLE_UPDATE_MUTATION,
            { id: existing.id, article: updatable },
            'UpdateArticle',
        );
        assertNoUserErrors('articleUpdate', data.articleUpdate);
        return { ...data.articleUpdate.article, created: false };
    }
    const data = await shopifyGraphql(
        ARTICLE_CREATE_MUTATION,
        { article: { ...articlePayload, blogId } },
        'CreateArticle',
    );
    assertNoUserErrors('articleCreate', data.articleCreate);
    return { ...data.articleCreate.article, created: true };
}
