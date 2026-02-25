/**
 * Embedder
 * 
 * Wraps the embeddings utility for batch processing with progress reporting.
 * Takes normalized + classified posts and adds embedding vectors.
 */

import { generateEmbeddings } from "./embeddings.js";

/**
 * Generate embeddings for an array of posts
 * @param {Array} posts - Posts with .content field
 * @param {Function} [onProgress] - Progress callback (completed, total)
 * @returns {Promise<Array>} Posts with .embedding field added
 */
export async function embedPosts(posts, onProgress) {
    if (!posts || posts.length === 0) return [];

    // Extract text content for embedding
    const texts = posts.map((p) => p.content || "");

    // Generate embeddings in batches
    const embeddings = await generateEmbeddings(texts, onProgress);

    // Attach embeddings to posts
    return posts.map((post, i) => ({
        ...post,
        embedding: embeddings[i] || null,
    }));
}

/**
 * Prepare posts for Pinecone upsert
 * Transforms embedded posts into the Pinecone vector format
 * @param {Array} posts - Posts with .embedding field
 * @returns {Array} Pinecone-ready vectors
 */
export function preparePineconeVectors(posts) {
    return posts
        .filter((p) => p.embedding && p.embedding.length > 0)
        .map((post) => ({
            id: post.id,
            values: post.embedding,
            metadata: {
                content: (post.content || "").slice(0, 35000), // Pinecone 40KB metadata limit
                platform: post.platform,
                format: post.format || "unknown",
                hookType: post.hookType || "unknown",
                niche: post.niche || "general",
                engagementScore: post.engagementScore || 0,
                wordCount: post.wordCount || 0,
                hasCta: post.hasCta || false,
                postedAt: post.postedAt || "",
                authorName: post.authorName || "",
                authorHandle: post.authorHandle || "",
                authorFollowerCount: post.authorFollowerCount || 0,
                likes: post.likes || 0,
                comments: post.comments || 0,
                shares: post.shares || 0,
                impressions: post.impressions || 0,
                media: post.media ? JSON.stringify(post.media) : "",
            },
        }));
}
