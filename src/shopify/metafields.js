import { shopifyGraphql, assertNoUserErrors } from './client.js';

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
            metafields { key namespace ownerType value }
            userErrors { field message code }
        }
    }
`;

export async function setMetafields(entries) {
    if (!entries.length) return [];
    const data = await shopifyGraphql(
        METAFIELDS_SET_MUTATION,
        { metafields: entries },
        'MetafieldsSet',
    );
    assertNoUserErrors('metafieldsSet', data.metafieldsSet);
    return data.metafieldsSet.metafields;
}

const METAFIELD_DEFINITION_CREATE = /* GraphQL */ `
    mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name namespace key }
            userErrors { field message code }
        }
    }
`;

const METAFIELD_DEFINITIONS_BY_OWNER = /* GraphQL */ `
    query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $namespace: String!) {
        metafieldDefinitions(first: 50, ownerType: $ownerType, namespace: $namespace) {
            nodes { id name namespace key type { name } }
        }
    }
`;

export async function ensureMetafieldDefinition(definition) {
    const existing = await shopifyGraphql(
        METAFIELD_DEFINITIONS_BY_OWNER,
        { ownerType: definition.ownerType, namespace: definition.namespace },
        'MetafieldDefinitions',
    );
    const match = existing.metafieldDefinitions.nodes.find(
        (node) => node.key === definition.key,
    );
    if (match) return match;
    const data = await shopifyGraphql(
        METAFIELD_DEFINITION_CREATE,
        { definition },
        'CreateMetafieldDefinition',
    );
    // duplicate-creation race is fine — surface and ignore the "taken" code
    if (data.metafieldDefinitionCreate.userErrors?.some((err) => err.code === 'TAKEN')) {
        return null;
    }
    assertNoUserErrors('metafieldDefinitionCreate', data.metafieldDefinitionCreate);
    return data.metafieldDefinitionCreate.createdDefinition;
}

const METAFIELD_DEFINITION_DELETE = /* GraphQL */ `
    mutation DeleteMetafieldDefinition($id: ID!, $deleteAllAssociatedMetafields: Boolean!) {
        metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: $deleteAllAssociatedMetafields) {
            deletedDefinitionId
            userErrors { field message code }
        }
    }
`;

export async function deleteMetafieldDefinitionByKey({ ownerType, namespace, key }) {
    const existing = await shopifyGraphql(
        METAFIELD_DEFINITIONS_BY_OWNER,
        { ownerType, namespace },
        'MetafieldDefinitions',
    );
    const match = existing.metafieldDefinitions.nodes.find((node) => node.key === key);
    if (!match) return false;
    const data = await shopifyGraphql(
        METAFIELD_DEFINITION_DELETE,
        { id: match.id, deleteAllAssociatedMetafields: true },
        'DeleteMetafieldDefinition',
    );
    assertNoUserErrors('metafieldDefinitionDelete', data.metafieldDefinitionDelete);
    return true;
}

export async function deleteMetafieldDefinitionIfTypeMismatch({ ownerType, namespace, key, expectedType }) {
    const existing = await shopifyGraphql(
        METAFIELD_DEFINITIONS_BY_OWNER,
        { ownerType, namespace },
        'MetafieldDefinitions',
    );
    const match = existing.metafieldDefinitions.nodes.find((node) => node.key === key);
    if (!match) return false;
    if (match.type?.name === expectedType) return false;
    const data = await shopifyGraphql(
        METAFIELD_DEFINITION_DELETE,
        { id: match.id, deleteAllAssociatedMetafields: true },
        'DeleteMetafieldDefinition',
    );
    assertNoUserErrors('metafieldDefinitionDelete', data.metafieldDefinitionDelete);
    return true;
}
