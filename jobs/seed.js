/**
 * Seed Job
 * 
 * Full pipeline orchestrator: scrape → normalize → classify → embed → upsert
 * Used for the initial seeding of the top-posts Pinecone namespace.
 */

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
import { embedPosts, preparePineconeVectors } from "../pipeline/embedder.js";
import { upsertTopPosts, getStats } from "../pinecone/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load creators from the registry
 */
async function loadCreators(options = {}) {
    const { niche, platform, limit } = options;
    const creatorsPath = path.join(__dirname, "..", "config", "creators.json");
    const raw = await fs.readFile(creatorsPath, "utf-8");
    const data = JSON.parse(raw);

    const result = { linkedin: [], x: [] };

    for (const [nicheKey, nicheData] of Object.entries(data.niches)) {
        if (niche && nicheKey !== niche) continue;

        if (!platform || platform === "linkedin") {
            const creators = limit
                ? nicheData.linkedin.slice(0, limit)
                : nicheData.linkedin;
            result.linkedin.push(
                ...creators.map((c) => ({ ...c, niche: nicheKey }))
            );
        }

        if (!platform || platform === "x") {
            const creators = limit
                ? nicheData.x.slice(0, limit)
                : nicheData.x;
            result.x.push(...creators.map((c) => ({ ...c, niche: nicheKey })));
        }
    }

    return result;
}

/**
 * Run the full seed pipeline
 */
export async function seedTopPosts(options = {}) {
    const {
        niche = null,
        platform = null,
        limit = null,
        skipTo = 0,
        dryRun = false,
        maxTweetsPerCreator = 30,
        maxLinkedInPostsPerCreator = 25,
        minEngagementScore = 50,
    } = options;

    const startTime = Date.now();
    console.log("\n🚀 Starting Top Posts Seed Pipeline");
    console.log("─".repeat(50));
    console.log(`Options: niche=${niche || "all"}, platform=${platform || "all"}, limit=${limit || "none"}, skipTo=${skipTo || 0}, dryRun=${dryRun}`);

    // 1. Load creators
    const creators = await loadCreators({ niche, platform, limit });
    console.log(`\n📋 Loaded ${creators.x.length} X creators + ${creators.linkedin.length} LinkedIn creators`);

    const allRawPosts = [];
    const failures = { x: [], linkedin: [] };    // Track failed creators
    const successes = { x: 0, linkedin: 0 };      // Track success counts

    // 2. Scrape X
    if (creators.x.length > 0) {
        console.log("\n🐦 Scraping X/Twitter...");
        let xClient = new XClient();
        await xClient.initialize();

        for (let i = 0; i < creators.x.length; i++) {
            const creator = creators.x[i];
            console.log(`  [${i + 1}/${creators.x.length}] @${creator.handle} (${creator.niche})`);

            // Skip if resuming from a later position
            if (skipTo && i + 1 < skipTo) {
                console.log(`      ⏭️ Skipped (--skip-to ${skipTo})`);
                continue;
            }

            try {
                const profile = await xClient.fetchCreatorProfile(creator.handle);
                const tweets = await xClient.fetchCreatorTweets(creator.handle, maxTweetsPerCreator);

                const normalized = tweets.map((t) =>
                    normalizeXTweet(t, creator, profile, creator.niche)
                );
                allRawPosts.push(...normalized);

                console.log(`      → ${tweets.length} tweets fetched, ${normalized.length} normalized`);
                if (tweets.length > 0) successes.x++;
                else failures.x.push({ handle: creator.handle, niche: creator.niche, reason: "0 tweets returned" });
            } catch (error) {
                console.error(`      ❌ Error: ${error.message}`);
                failures.x.push({ handle: creator.handle, niche: creator.niche, reason: error.message });

                // If browser crashed, try to recover
                if (error.message.includes("has been closed") || error.message.includes("Target closed") || error.message.includes("not initialized")) {
                    console.log("      🔄 Browser crashed — reinitializing X client...");
                    try { await xClient.cleanup(); } catch { }
                    xClient = new XClient();
                    await xClient.initialize();
                }
            }

            // Adaptive delay between creators
            if (i < creators.x.length - 1) {
                const delay = xClient.getCreatorDelay();
                if (delay > 10000) {
                    console.log(`      ⏳ Throttled — waiting ${Math.round(delay / 1000)}s before next creator...`);
                }
                await sleep(delay);
            }

            // Save intermediate progress every 25 creators
            if ((i + 1) % 25 === 0 && !dryRun) {
                await saveProgress(allRawPosts, failures, "x-checkpoint");
            }
        }

        await xClient.cleanup();
    }

    // 3. Scrape LinkedIn
    if (creators.linkedin.length > 0) {
        console.log("\n🔗 Scraping LinkedIn...");
        let linkedinClient = new LinkedInClient();
        await linkedinClient.initialize();

        for (let i = 0; i < creators.linkedin.length; i++) {
            const creator = creators.linkedin[i];
            const profileUrl = `https://www.linkedin.com/in/${creator.handle}`;
            console.log(`  [${i + 1}/${creators.linkedin.length}] ${creator.name} (${creator.niche})`);

            // Skip if resuming from a later position
            if (skipTo && i + 1 < skipTo) {
                console.log(`      ⏭️ Skipped (--skip-to ${skipTo})`);
                continue;
            }

            try {
                const posts = await linkedinClient.fetchCreatorPosts(profileUrl, maxLinkedInPostsPerCreator);

                const normalized = posts.map((p) =>
                    normalizeLinkedInPost(p, creator, creator.niche)
                );
                allRawPosts.push(...normalized);

                console.log(`      → ${posts.length} posts fetched, ${normalized.length} normalized`);
                if (posts.length > 0) successes.linkedin++;
                else failures.linkedin.push({ handle: creator.handle, name: creator.name, niche: creator.niche, reason: "0 posts returned" });
            } catch (error) {
                console.error(`      ❌ Error: ${error.message}`);
                failures.linkedin.push({ handle: creator.handle, name: creator.name, niche: creator.niche, reason: error.message });

                // If browser crashed, try to recover
                if (error.message.includes("has been closed") || error.message.includes("Target closed") || error.message.includes("not initialized")) {
                    console.log("      🔄 Browser crashed — reinitializing LinkedIn client...");
                    try { await linkedinClient.cleanup(); } catch { }
                    linkedinClient = new LinkedInClient();
                    await linkedinClient.initialize();
                }
            }

            // Delay between LinkedIn profiles (5-10 seconds — LinkedIn is stricter)
            if (i < creators.linkedin.length - 1) {
                const delay = 5000 + Math.random() * 5000;
                await sleep(delay);
            }

            // Save intermediate progress every 25 creators
            if ((i + 1) % 25 === 0 && !dryRun) {
                await saveProgress(allRawPosts, failures, "linkedin-checkpoint");
            }
        }

        await linkedinClient.cleanup();
    }

    console.log(`\n📊 Raw posts collected: ${allRawPosts.length}`);

    // 4. Thread detection (X only)
    console.log("\n🧵 Detecting threads...");
    const xPosts = allRawPosts.filter((p) => p.platform === "x");
    const liPosts = allRawPosts.filter((p) => p.platform === "linkedin");
    const mergedXPosts = detectAndMergeThreads(xPosts);
    const allNormalized = [...mergedXPosts, ...liPosts];
    console.log(`   Threads merged: ${xPosts.length} tweets → ${mergedXPosts.length} entries`);

    // 5. Deduplicate
    const deduplicated = deduplicateByContentHash(allNormalized);
    console.log(`   Deduplicated: ${allNormalized.length} → ${deduplicated.length}`);

    // 6. Filter by engagement
    const filtered = filterByEngagement(deduplicated, minEngagementScore);
    console.log(`   Filtered (score >= ${minEngagementScore}): ${filtered.length} posts`);

    if (filtered.length === 0) {
        console.log("\n⚠️  No posts passed the engagement filter. Try lowering --min-score.");
        return { total: 0 };
    }

    // 7. Classify
    console.log("\n🏷️  Classifying posts...");
    const classified = await classifyBatch(filtered, (done, total) => {
        process.stdout.write(`\r   Classified: ${done}/${total}`);
    });
    console.log(""); // newline after progress

    // 8. Embed
    console.log("\n🧠 Generating embeddings...");
    const embedded = await embedPosts(classified, (done, total) => {
        process.stdout.write(`\r   Embedded: ${done}/${total}`);
    });
    console.log(""); // newline after progress

    // 9. Prepare and upsert to Pinecone
    const vectors = preparePineconeVectors(embedded);
    console.log(`\n📌 Prepared ${vectors.length} vectors for Pinecone`);

    if (!dryRun) {
        console.log("   Upserting to Pinecone...");
        await upsertTopPosts(vectors, (done, total) => {
            process.stdout.write(`\r   Upserted: ${done}/${total}`);
        });
        console.log(""); // newline after progress

        const stats = await getStats();
        console.log(`   Pinecone top-posts count: ${stats.topPostsCount}`);
    } else {
        console.log("   🔍 DRY RUN — skipping Pinecone upsert");
    }

    // 10. Summary
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const byNiche = {};
    const byPlatform = { x: 0, linkedin: 0 };

    for (const post of embedded) {
        byNiche[post.niche] = (byNiche[post.niche] || 0) + 1;
        byPlatform[post.platform]++;
    }

    const totalFailures = failures.x.length + failures.linkedin.length;

    console.log("\n" + "═".repeat(50));
    console.log("✅ SEED COMPLETE");
    console.log("═".repeat(50));
    console.log(`Total posts: ${vectors.length}`);
    console.log(`By platform: X=${byPlatform.x}, LinkedIn=${byPlatform.linkedin}`);
    console.log(`By niche: ${JSON.stringify(byNiche)}`);
    console.log(`Scrape success: X=${successes.x}/${creators.x.length}, LinkedIn=${successes.linkedin}/${creators.linkedin.length}`);
    console.log(`Time elapsed: ${elapsed} minutes`);
    console.log(`Dry run: ${dryRun}`);

    // Report failures
    if (totalFailures > 0) {
        console.log(`\n⚠️  ${totalFailures} creators failed:`);
        if (failures.x.length > 0) {
            console.log(`  X failures (${failures.x.length}):`);
            for (const f of failures.x) {
                console.log(`    - @${f.handle} (${f.niche}): ${f.reason}`);
            }
        }
        if (failures.linkedin.length > 0) {
            console.log(`  LinkedIn failures (${failures.linkedin.length}):`);
            for (const f of failures.linkedin) {
                console.log(`    - ${f.name || f.handle} (${f.niche}): ${f.reason}`);
            }
        }
    }

    // Save results to file for reference
    if (!dryRun) {
        const outputDir = path.join(__dirname, "..", "data", "output");
        await fs.mkdir(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, `seed-${new Date().toISOString().slice(0, 10)}.json`);
        await fs.writeFile(
            outputPath,
            JSON.stringify(
                {
                    total: vectors.length, byNiche, byPlatform,
                    scrapeSuccess: successes,
                    scrapeFailures: { x: failures.x.length, linkedin: failures.linkedin.length, details: failures },
                    timestamp: new Date().toISOString(),
                },
                null,
                2
            )
        );
        console.log(`Results saved to: ${outputPath}`);
    }

    return { total: vectors.length, byNiche, byPlatform, failures };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveProgress(posts, failures, label) {
    try {
        const outputDir = path.join(__dirname, "..", "data", "output");
        await fs.mkdir(outputDir, { recursive: true });
        const progressPath = path.join(outputDir, `seed-progress-${label}.json`);
        await fs.writeFile(
            progressPath,
            JSON.stringify({
                postsCollected: posts.length,
                failures,
                savedAt: new Date().toISOString(),
            }, null, 2)
        );
        console.log(`  💾 Progress saved (${posts.length} posts so far)`);
    } catch (e) {
        // Non-critical, don't crash
        console.log(`  ⚠️ Could not save progress: ${e.message}`);
    }
}
