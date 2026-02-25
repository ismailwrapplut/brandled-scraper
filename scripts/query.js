#!/usr/bin/env node

/**
 * CLI: Query top posts from Pinecone
 * 
 * Demonstrates how an LLM agent would retrieve relevant posts
 * from the vector database using semantic search.
 * 
 * Usage:
 *   node scripts/query.js "how to grow on linkedin"
 *   node scripts/query.js "solopreneur business tips" --platform x --limit 5
 *   node scripts/query.js "content creation" --format listicle --niche saas
 */

import "dotenv/config";
import { generateEmbedding } from "../pipeline/embeddings.js";
import { queryTopPosts } from "../pinecone/client.js";

// Parse arguments
const args = process.argv.slice(2);
const queryText = args.find(a => !a.startsWith("--")) || "content creation tips";

function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("--")
        ? args[idx + 1]
        : undefined;
}

const platform = getArg("platform");
const format = getArg("format");
const hookType = getArg("hookType");
const niche = getArg("niche");
const limit = parseInt(getArg("limit") || "5", 10);

console.log(`\n🔍 Searching: "${queryText}"`);
console.log(`   Filters: platform=${platform || "any"}, format=${format || "any"}, niche=${niche || "any"}`);
console.log(`   Limit: ${limit}\n`);

// Step 1: Embed the query
console.log("📐 Generating query embedding...");
const queryEmbedding = await generateEmbedding(queryText);
console.log(`   → ${queryEmbedding.length}-dimensional vector\n`);

// Step 2: Build metadata filter
const filter = {};
if (platform) filter.platform = { $eq: platform };
if (format) filter.format = { $eq: format };
if (hookType) filter.hookType = { $eq: hookType };
if (niche) filter.niche = { $eq: niche };

// Step 3: Query Pinecone
console.log("📌 Querying Pinecone...");
const results = await queryTopPosts(queryEmbedding, filter, limit);
console.log(`   → ${results.length} results found\n`);

// Step 4: Display results
console.log("═".repeat(70));
console.log("  RESULTS — Ranked by semantic similarity");
console.log("═".repeat(70));

for (let i = 0; i < results.length; i++) {
    const post = results[i];
    const similarity = (post.score * 100).toFixed(1);

    console.log(`\n  #${i + 1} — ${similarity}% match | ${post.platform.toUpperCase()}`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  Author: ${post.authorName} (@${post.authorHandle})`);
    console.log(`  Format: ${post.format} | Hook: ${post.hookType} | Niche: ${post.niche}`);
    console.log(`  Engagement: 👍 ${post.likes} | 💬 ${post.comments} | 🔄 ${post.shares} | Score: ${post.engagementScore}`);
    if (post.postedAt) console.log(`  Posted: ${post.postedAt}`);

    // Show media info
    if (post.media) {
        try {
            const media = JSON.parse(post.media);
            if (media.length > 0) {
                const types = media.map(m => m.type).join(', ');
                console.log(`  📎 Media: ${media.length} item(s) — [${types}]`);
            }
        } catch { }
    }

    console.log(`  Content:`);
    // Show content with line wrapping
    const lines = post.content.split("\n").slice(0, 8);
    for (const line of lines) {
        if (line.trim()) console.log(`    ${line.slice(0, 100)}`);
    }
    if (post.content.split("\n").length > 8) console.log(`    ...`);
}

// Step 5: Show what the LLM context would look like
console.log("\n\n" + "═".repeat(70));
console.log("  LLM CONTEXT — What gets injected into the agent's prompt");
console.log("═".repeat(70));

const llmContext = results.map((post, i) => {
    let entry = `[Top Post ${i + 1}] — ${post.platform.toUpperCase()} by ${post.authorName}
Format: ${post.format} | Hook: ${post.hookType} | Niche: ${post.niche}
Engagement: ${post.likes} likes, ${post.comments} comments, ${post.shares} shares (score: ${post.engagementScore})
Content:
${post.content.slice(0, 500)}`;

    if (post.media) {
        try {
            const media = JSON.parse(post.media);
            if (media.length > 0) {
                entry += `\nMedia: ${media.map(m => `${m.type}${m.url ? ` (${m.url.slice(0, 60)}...)` : ''}`).join(', ')}`;
            }
        } catch { }
    }

    return entry;
}).join("\n\n---\n\n");

console.log("\n" + llmContext);

console.log("\n\n" + "─".repeat(70));
console.log(`  Total tokens (approx): ~${Math.round(llmContext.length / 4)} tokens`);
console.log("─".repeat(70));
