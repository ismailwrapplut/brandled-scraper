#!/usr/bin/env node

/**
 * CLI: Inspect scraped data
 * 
 * Runs the pipeline in dry-run mode and saves the full classified data
 * to a readable JSON file so you can inspect what goes into Pinecone.
 * 
 * Usage:
 *   node scripts/inspect.js --niche saas --platform x --limit 1
 *   node scripts/inspect.js --niche saas --platform linkedin --limit 1
 */

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { XClient } from "../clients/x-client.js";
import { LinkedInClient } from "../clients/linkedin-client.js";
import {
    normalizeXTweet,
    normalizeLinkedInPost,
    detectAndMergeThreads,
    deduplicateByContentHash,
    filterByEngagement,
} from "../pipeline/normalizer.js";
import { classifyBatch } from "../pipeline/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name) {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    if (index + 1 >= args.length) return true;
    const next = args[index + 1];
    if (next.startsWith("--")) return true;
    return next;
}

const niche = getArg("niche") || "saas";
const platform = getArg("platform") || "x";
const limit = getArg("limit") ? parseInt(getArg("limit"), 10) : 1;
const skipClassify = args.includes("--skip-classify");

// Load creators
const creatorsPath = path.join(__dirname, "..", "config", "creators.json");
const creatorsData = JSON.parse(await fs.readFile(creatorsPath, "utf-8"));
const nicheData = creatorsData.niches[niche];

if (!nicheData) {
    console.error(`Niche "${niche}" not found. Available: ${Object.keys(creatorsData.niches).join(", ")}`);
    process.exit(1);
}

const creators = (nicheData[platform] || []).slice(0, limit).map(c => ({ ...c, niche }));
console.log(`\n🔍 Inspecting ${creators.length} ${platform} creator(s) in "${niche}"\n`);

let allPosts = [];

if (platform === "x") {
    const client = new XClient();
    await client.initialize();

    for (const creator of creators) {
        console.log(`  Scraping @${creator.handle}...`);
        const profile = await client.fetchCreatorProfile(creator.handle);
        const tweets = await client.fetchCreatorTweets(creator.handle, 30);
        const normalized = tweets.map(t => normalizeXTweet(t, creator, profile, niche));
        allPosts.push(...normalized);
        console.log(`    → ${tweets.length} tweets fetched`);
    }

    await client.cleanup();

    // Merge threads
    allPosts = detectAndMergeThreads(allPosts);
} else {
    const client = new LinkedInClient();
    await client.initialize();

    for (const creator of creators) {
        const profileUrl = `https://www.linkedin.com/in/${creator.handle}`;
        console.log(`  Scraping ${creator.name} (${creator.handle})...`);
        const posts = await client.fetchCreatorPosts(profileUrl, 25);
        const normalized = posts.map(p => normalizeLinkedInPost(p, creator, niche));
        allPosts.push(...normalized);
        console.log(`    → ${posts.length} posts fetched`);
    }

    await client.cleanup();
}

// Deduplicate
allPosts = deduplicateByContentHash(allPosts);

// Filter
const filtered = filterByEngagement(allPosts, 0); // Show all — no filter for inspection
console.log(`\n📊 Total posts after dedup: ${filtered.length}`);

// Classify (unless skipped for speed)
let finalPosts = filtered;
if (!skipClassify && filtered.length > 0) {
    console.log("\n🏷️  Classifying...");
    finalPosts = await classifyBatch(filtered, (done, total) => {
        process.stdout.write(`\r   ${done}/${total}`);
    });
    console.log("");
}

// Clean up internal fields before display
const displayPosts = finalPosts.map(p => {
    const { _raw, contentHash, embedding, ...display } = p;
    return display;
});

// Save to file
const outputDir = path.join(__dirname, "..", "data", "output");
await fs.mkdir(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `inspect-${platform}-${niche}.json`);
await fs.writeFile(outputFile, JSON.stringify(displayPosts, null, 2));

console.log(`\n✅ Saved ${displayPosts.length} posts to: ${outputFile}`);

// Show first 3 as preview
console.log("\n─── PREVIEW (first 3 posts) ───\n");
for (const post of displayPosts.slice(0, 3)) {
    console.log(`📝 ${post.authorName} (@${post.authorHandle}) — ${post.platform}`);
    console.log(`   Format: ${post.format || "?"} | Hook: ${post.hookType || "?"} | Niche: ${post.niche}`);
    console.log(`   Score: ${post.engagementScore} | 👍 ${post.likes} | 💬 ${post.comments} | 🔄 ${post.shares}`);
    if (post.media && post.media.length > 0) {
        const mediaTypes = post.media.map(m => m.type).join(', ');
        console.log(`   📎 Media: ${post.media.length} item(s) — [${mediaTypes}]`);
    }
    console.log(`   Content: ${(post.content || "").slice(0, 150)}...`);
    console.log("");
}
