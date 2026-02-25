/**
 * OpenAI Embeddings Utility (Azure OpenAI)
 * 
 * Generates text embeddings using Azure OpenAI's text-embedding-3-small deployment.
 * Used for vectorizing posts before upserting to Pinecone.
 */

import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
});

const EMBEDDING_DEPLOYMENT = process.env.AZURE_EMBEDDING_DEPLOYMENT || "text-embedding-3-small";
const DIMENSIONS = 512; // Must match Pinecone index dimension
const MAX_BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Generate embedding for a single text
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} 1536-dimensional vector
 */
export async function generateEmbedding(text) {
    if (!text || typeof text !== "string") {
        throw new Error("generateEmbedding: text must be a non-empty string");
    }

    // Truncate to ~8000 tokens (~32000 chars) to stay within model limits
    const truncated = text.slice(0, 32000);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.embeddings.create({
                model: EMBEDDING_DEPLOYMENT,
                input: truncated,
                dimensions: DIMENSIONS,
            });
            return response.data[0].embedding;
        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            if (error?.status === 429) {
                const wait = RETRY_DELAY_MS * attempt * 2;
                console.warn(`Rate limited on embedding, retrying in ${wait}ms...`);
                await sleep(wait);
            } else {
                const wait = RETRY_DELAY_MS * attempt;
                console.warn(`Embedding error (attempt ${attempt}/${MAX_RETRIES}): ${error.message}. Retrying in ${wait}ms...`);
                await sleep(wait);
            }
        }
    }
}

/**
 * Generate embeddings for multiple texts in batches
 * @param {string[]} texts - Array of texts to embed
 * @param {Function} [onProgress] - Optional progress callback (completed, total)
 * @returns {Promise<number[][]>} Array of 1536-dimensional vectors
 */
export async function generateEmbeddings(texts, onProgress) {
    if (!Array.isArray(texts) || texts.length === 0) {
        return [];
    }

    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const truncatedBatch = batch.map(t => (t || "").slice(0, 32000));

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await client.embeddings.create({
                    model: EMBEDDING_DEPLOYMENT,
                    input: truncatedBatch,
                    dimensions: DIMENSIONS,
                });

                // Azure returns embeddings in order
                const embeddings = response.data
                    .sort((a, b) => a.index - b.index)
                    .map(d => d.embedding);

                allEmbeddings.push(...embeddings);

                if (onProgress) {
                    onProgress(allEmbeddings.length, texts.length);
                }

                break; // Success, move to next batch
            } catch (error) {
                if (attempt === MAX_RETRIES) throw error;
                if (error?.status === 429) {
                    const wait = RETRY_DELAY_MS * attempt * 2;
                    console.warn(`Rate limited on batch embedding, retrying in ${wait}ms...`);
                    await sleep(wait);
                } else {
                    const wait = RETRY_DELAY_MS * attempt;
                    console.warn(`Batch embedding error (attempt ${attempt}): ${error.message}. Retrying in ${wait}ms...`);
                    await sleep(wait);
                }
            }
        }
    }

    return allEmbeddings;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export { DIMENSIONS, EMBEDDING_DEPLOYMENT };
