/**
 * Classifier (Azure OpenAI)
 * 
 * Uses Azure OpenAI to classify each post's format, hook type, niche,
 * and CTA presence. Compatible with both GPT and reasoning models.
 */

import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
});

const CLASSIFIER_DEPLOYMENT = process.env.AZURE_CLASSIFIER_DEPLOYMENT || "gpt-4o-mini";
const MAX_CONCURRENCY = 5; // Lower to avoid rate limits
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const CLASSIFICATION_PROMPT = `You are a social media content analyst. Classify the following post.

You MUST respond with ONLY a valid JSON object — no markdown, no code fences, no explanation. Just the raw JSON.

{
  "format": one of ["storytelling", "framework", "listicle", "hot_take", "how_to", "thread", "question", "announcement", "case_study", "personal_update", "quote", "poll"],
  "hookType": one of ["contrarian", "curiosity_gap", "stat_based", "story_opener", "bold_claim", "question", "result_first", "listicle_tease", "direct", "emotional", "authority"],
  "niche": one of ["saas", "marketing", "ai_tech", "leadership", "startup", "creator_economy", "sales", "product", "engineering", "design", "finance", "health", "career", "general"],
  "hasCta": true or false
}

Rules:
- "format" describes the structural format of the post
- "hookType" describes the opening line strategy
- "niche" is the primary topic area
- "hasCta" is true if the post asks readers to do something (follow, comment, share, click link, DM)
- RESPOND WITH ONLY THE JSON OBJECT. Nothing else.

Post:
"""
{POST_TEXT}
"""`;

/**
 * Classify a single post
 * @param {string} text - Post content
 * @returns {Promise<object>} Classification result
 */
export async function classifyPost(text) {
    const prompt = CLASSIFICATION_PROMPT.replace("{POST_TEXT}", text.slice(0, 3000));

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Use minimal params — compatible with both GPT and reasoning models
            const response = await client.chat.completions.create({
                model: CLASSIFIER_DEPLOYMENT,
                messages: [{ role: "user", content: prompt }],
            });

            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error("Empty response from classifier");

            // Clean response — remove markdown fences if present
            const cleaned = content
                .replace(/```json\s*/gi, "")
                .replace(/```\s*/g, "")
                .trim();

            const result = JSON.parse(cleaned);

            // Validate required fields
            if (!result.format || !result.hookType || !result.niche) {
                throw new Error("Missing required classification fields");
            }

            return {
                format: result.format,
                hookType: result.hookType,
                niche: result.niche,
                hasCta: Boolean(result.hasCta),
            };
        } catch (error) {
            if (attempt === MAX_RETRIES) {
                console.warn(`Classification failed after ${MAX_RETRIES} attempts: ${error.message}`);
                return { format: "unknown", hookType: "unknown", niche: "general", hasCta: false };
            }

            if (error?.status === 429) {
                await sleep(RETRY_DELAY_MS * attempt * 2);
            } else {
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }
    }
}

/**
 * Classify a batch of posts with concurrency control
 * @param {Array} posts - Array of normalized posts (must have .content field)
 * @param {Function} [onProgress] - Progress callback (completed, total)
 * @returns {Promise<Array>} Posts with classification fields filled in
 */
export async function classifyBatch(posts, onProgress) {
    if (!posts || posts.length === 0) return [];

    const results = [];
    let completed = 0;

    // Process in concurrent batches
    for (let i = 0; i < posts.length; i += MAX_CONCURRENCY) {
        const batch = posts.slice(i, i + MAX_CONCURRENCY);

        const batchResults = await Promise.all(
            batch.map(async (post) => {
                const presetFormat = post.format;
                const classification = await classifyPost(post.content);

                return {
                    ...post,
                    format: presetFormat || classification.format,
                    hookType: classification.hookType,
                    niche: post.niche || classification.niche,
                    hasCta: classification.hasCta,
                };
            })
        );

        results.push(...batchResults);
        completed += batch.length;

        if (onProgress) {
            onProgress(completed, posts.length);
        }

        // Delay between batches to avoid rate limits
        if (i + MAX_CONCURRENCY < posts.length) {
            await sleep(1000);
        }
    }

    return results;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export { CLASSIFIER_DEPLOYMENT };
