import { request } from 'undici';
import { shopifyGraphql, assertNoUserErrors } from './client.js';

const STAGED_UPLOADS_CREATE = /* GraphQL */ `
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
            stagedTargets {
                url
                resourceUrl
                parameters { name value }
            }
            userErrors { field message }
        }
    }
`;

const FILE_CREATE = /* GraphQL */ `
    mutation FileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
            files {
                id
                fileStatus
                ... on MediaImage { image { url } }
            }
            userErrors { field message code }
        }
    }
`;

const FILE_BY_ID = /* GraphQL */ `
    query FileById($id: ID!) {
        node(id: $id) {
            ... on MediaImage {
                id
                fileStatus
                image { url }
            }
        }
    }
`;

function inferMimeType(sourceUrl) {
    const lower = sourceUrl.toLowerCase().split('?')[0];
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    return 'image/jpeg';
}

function filenameFromUrl(sourceUrl) {
    const decoded = decodeURIComponent(sourceUrl.split('?')[0]);
    const last = decoded.split('/').pop() || 'image.jpg';
    return last.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function downloadBytes(sourceUrl) {
    const response = await request(sourceUrl, { method: 'GET', maxRedirections: 5 });
    if (response.statusCode !== 200) {
        throw new Error(`download ${sourceUrl} failed: HTTP ${response.statusCode}`);
    }
    return Buffer.from(await response.body.arrayBuffer());
}

async function uploadToStagedTarget(target, bytes, mimeType) {
    const form = new FormData();
    for (const param of target.parameters) form.append(param.name, param.value);
    form.append('file', new Blob([bytes], { type: mimeType }));
    const response = await request(target.url, { method: 'POST', body: form });
    if (response.statusCode >= 300) {
        const text = await response.body.text();
        throw new Error(`stagedUpload PUT failed: HTTP ${response.statusCode} ${text.slice(0, 200)}`);
    }
}

export async function uploadImageFromUrl(sourceUrl) {
    const mimeType = inferMimeType(sourceUrl);
    const filename = filenameFromUrl(sourceUrl);
    const bytes = await downloadBytes(sourceUrl);

    const staged = await shopifyGraphql(
        STAGED_UPLOADS_CREATE,
        {
            input: [{
                filename,
                mimeType,
                resource: 'IMAGE',
                httpMethod: 'POST',
                fileSize: String(bytes.length),
            }],
        },
        'StagedUploadsCreate',
    );
    assertNoUserErrors('stagedUploadsCreate', staged.stagedUploadsCreate);
    const target = staged.stagedUploadsCreate.stagedTargets[0];
    if (!target) throw new Error('stagedUploadsCreate returned no targets');

    await uploadToStagedTarget(target, bytes, mimeType);

    const created = await shopifyGraphql(
        FILE_CREATE,
        {
            files: [{
                originalSource: target.resourceUrl,
                contentType: 'IMAGE',
                alt: filename,
            }],
        },
        'FileCreate',
    );
    assertNoUserErrors('fileCreate', created.fileCreate);
    const file = created.fileCreate.files[0];
    if (!file?.id) throw new Error('fileCreate returned no file');
    return file.id;
}
