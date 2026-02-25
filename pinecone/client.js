/**
 * Pinecone Client + Upserter
 * 
 * Connects to the shared Brandled Pinecone index and upserts
 * top post vectors to the "top-posts" namespace.
 */

import { Pinecone } from "@pinecone-database/pinecone";

let client = null;
let index = null;

const INDEX_NAME = process.env.PINECONE_INDEX_NAME || "brandled-knowledge";
const NAMESPACE = "top-posts";
const UPSERT_BATCH_SIZE = 100; // Pinecone recommendation

/**
 * Get the Pinecone client (singleton)
 */
function getClient() {
    if (!client) {
        if (!process.env.PINECONE_API_KEY) {
            throw new Error("PINECONE_API_KEY is required");
        }
        client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    }
    return client;
}

/**
 * Get the Pinecone index reference
 */
function getIndex() {
    if (!index) {
        index = getClient().index(INDEX_NAME);
    }
    return index;
}

/**
 * Get the top-posts namespace reference
 */
function getNamespace() {
    return getIndex().namespace(NAMESPACE);
}

/**
 * Upsert vectors to the top-posts namespace
 * @param {Array<{id: string, values: number[], metadata: object}>} vectors
 * @param {Function} [onProgress] - Optional progress callback
 */
export async function upsertTopPosts(vectors, onProgress) {
    if (!vectors || vectors.length === 0) return;

    const ns = getNamespace();

    for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
        const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);

        await ns.upsert(batch);

        if (onProgress) {
            onProgress(Math.min(i + UPSERT_BATCH_SIZE, vectors.length), vectors.length);
        }
    }
}

/**
 * Query top posts by embedding similarity
 * @param {number[]} embedding - Query vector
 * @param {object} [filter] - Pinecone metadata filter
 * @param {number} [topK=10] - Number of results
 * @returns {Promise<Array>} Matching posts with scores and metadata
 */
export async function queryTopPosts(embedding, filter = {}, topK = 10) {
    const ns = getNamespace();

    const queryParams = {
        vector: embedding,
        topK,
        includeMetadata: true,
    };

    if (Object.keys(filter).length > 0) {
        queryParams.filter = filter;
    }

    const response = await ns.query(queryParams);

    return (response.matches || []).map(match => ({
        id: match.id,
        score: match.score,
        ...match.metadata,
    }));
}

/**
 * Delete vectors by IDs
 * @param {string[]} ids - Vector IDs to delete
 */
export async function deleteTopPosts(ids) {
    if (!ids || ids.length === 0) return;
    const ns = getNamespace();
    await ns.deleteMany(ids);
}

/**
 * Delete vectors by metadata filter
 * @param {object} filter - Pinecone metadata filter
 */
export async function deleteByFilter(filter) {
    const ns = getNamespace();
    await ns.deleteMany({ filter });
}

/**
 * Get stats for the namespace
 */
export async function getStats() {
    const idx = getIndex();
    const stats = await idx.describeIndexStats();
    return {
        totalVectors: stats.totalRecordCount,
        namespaces: stats.namespaces,
        topPostsCount: stats.namespaces?.[NAMESPACE]?.recordCount || 0,
    };
}

export { NAMESPACE, INDEX_NAME };
