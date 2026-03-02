/**
 * Seed Job
 * 
 * Full pipeline orchestrator: scrape → normalize → classify → embed → upsert
 * Used for the initial seeding of the top-posts Pinecone namespace.
 * 
 * Pipeline runs PER-CREATOR so that partial failures don't lose already-processed data.
 * LinkedIn uses a rotating account+proxy pool for resilience.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { XClient } from "../clients/x-client.js";
import { LinkedInClient } from "../clients/linkedin-client.js";
import { LinkedInAccountPool } from "../clients/linkedin-account-pool.js";
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
 * Run the full seed pipeline (per-creator processing)
 *
 * For each creator: scrape → normalize → classify → embed → upsert to Pinecone.
 * This ensures partially-completed runs still persist already-classified data.
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
    console.log("\n🚀 Starting Top Posts Seed Pipeline (per-creator mode)");
    console.log("─".repeat(50));
    console.log(`Options: niche=${niche || "all"}, platform=${platform || "all"}, limit=${limit || "none"}, skipTo=${skipTo || 0}, dryRun=${dryRun}`);

    // 1. Load creators
    const creators = await loadCreators({ niche, platform, limit });
    console.log(`\n📋 Loaded ${creators.x.length} X creators + ${creators.linkedin.length} LinkedIn creators`);

    // Tracking
    const allVectors = [];
    const failures = { x: [], linkedin: [] };
    const successes = { x: 0, linkedin: 0 };
    const byNiche = {};
    const byPlatform = { x: 0, linkedin: 0 };

    // ══════════════════════════════════════════════════════════════
    //  X Creators — per-creator pipeline
    // ══════════════════════════════════════════════════════════════
    if (creators.x.length > 0) {
        console.log("\n🐦 Processing X/Twitter creators (scrape → classify → embed → upsert each)...");
        let xClient = new XClient();
        await xClient.initialize();

        for (let i = 0; i < creators.x.length; i++) {
            const creator = creators.x[i];
            console.log(`\n  [X ${i + 1}/${creators.x.length}] @${creator.handle} (${creator.niche})`);

            if (skipTo && i + 1 < skipTo) {
                console.log(`      ⏭️ Skipped (--skip-to ${skipTo})`);
                continue;
            }

            try {
                // SCRAPE
                const profile = await xClient.fetchCreatorProfile(creator.handle);
                const tweets = await xClient.fetchCreatorTweets(creator.handle, maxTweetsPerCreator);

                if (tweets.length === 0) {
                    failures.x.push({ handle: creator.handle, niche: creator.niche, reason: "0 tweets returned" });
                    continue;
                }

                // NORMALIZE
                let normalized = tweets.map((t) =>
                    normalizeXTweet(t, creator, profile, creator.niche)
                );

                // Thread detection (X only)
                normalized = detectAndMergeThreads(normalized);
                normalized = deduplicateByContentHash(normalized);
                normalized = filterByEngagement(normalized, minEngagementScore);

                if (normalized.length === 0) {
                    console.log(`      → ${tweets.length} tweets fetched, 0 passed filters`);
                    successes.x++;
                    continue;
                }

                // CLASSIFY
                const classified = await classifyBatch(normalized);

                // EMBED
                const embedded = await embedPosts(classified);

                // UPSERT
                const vectors = preparePineconeVectors(embedded);
                if (vectors.length > 0 && !dryRun) {
                    await upsertTopPosts(vectors);
                }

                allVectors.push(...vectors);
                for (const post of embedded) {
                    byNiche[post.niche] = (byNiche[post.niche] || 0) + 1;
                    byPlatform.x++;
                }

                successes.x++;
                console.log(`      ✅ ${tweets.length} tweets → ${vectors.length} vectors ${dryRun ? "(dry run)" : "upserted"}`);
            } catch (error) {
                console.error(`      ❌ Error: ${error.message}`);
                failures.x.push({ handle: creator.handle, niche: creator.niche, reason: error.message });

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
        }

        await xClient.cleanup();
    }

    // ══════════════════════════════════════════════════════════════
    //  LinkedIn Creators — per-creator pipeline with account pool
    // ══════════════════════════════════════════════════════════════
    if (creators.linkedin.length > 0) {
        console.log("\n🔗 Processing LinkedIn creators (scrape → classify → embed → upsert each)...");

        // Initialize account pool
        const pool = new LinkedInAccountPool().load();

        if (pool.size === 0) {
            console.log("  ⚠️ No LinkedIn accounts configured — skipping LinkedIn scraping");
        } else {
            // Pre-initialize one client per healthy pair so we can reuse browsers
            /** @type {Map<number, LinkedInClient>} */
            const clientCache = new Map();

            /**
             * Get or create a LinkedInClient for a given account pair.
             */
            async function getOrCreateClient(pair) {
                if (clientCache.has(pair.id)) {
                    const cached = clientCache.get(pair.id);
                    if (cached.browser) return cached;
                    // Browser died — recreate
                    clientCache.delete(pair.id);
                }
                const client = new LinkedInClient(pair);
                await client.initialize();
                clientCache.set(pair.id, client);
                return client;
            }

            /**
             * Attempt to scrape a LinkedIn creator using the pool with fallback.
             * Tries each healthy pair until one succeeds.
             * @returns {{ posts: Array, pair: object } | null}
             */
            async function scrapeWithPool(profileUrl, maxPosts) {
                const healthyPairs = pool.allHealthy();
                if (healthyPairs.length === 0) return null;

                for (const pair of healthyPairs) {
                    let client;
                    try {
                        client = await getOrCreateClient(pair);
                        const posts = await client.fetchCreatorPosts(profileUrl, maxPosts);

                        pool.reportSuccess(pair);
                        return { posts, pair };
                    } catch (error) {
                        const msg = error.message || "";
                        console.log(`      ⚠️ [${pair.label}] failed: ${msg.substring(0, 100)}`);

                        const isFatal =
                            msg.includes("login") ||
                            msg.includes("authwall") ||
                            msg.includes("cookie invalid") ||
                            msg.includes("cookie expired");

                        pool.reportFailure(pair, msg, isFatal);

                        // Destroy the client for this pair if it's a browser crash
                        if (msg.includes("has been closed") || msg.includes("Target closed")) {
                            try { await client?.cleanup(); } catch { }
                            clientCache.delete(pair.id);
                        }
                    }
                }

                return null; // All pairs failed
            }

            for (let i = 0; i < creators.linkedin.length; i++) {
                const creator = creators.linkedin[i];
                const profileUrl = `https://www.linkedin.com/in/${creator.handle}`;
                console.log(`\n  [LI ${i + 1}/${creators.linkedin.length}] ${creator.name} (${creator.niche})`);

                if (skipTo && i + 1 < skipTo) {
                    console.log(`      ⏭️ Skipped (--skip-to ${skipTo})`);
                    continue;
                }

                if (!pool.hasAvailable) {
                    console.log("      ⚠️ No healthy LinkedIn accounts available — stopping LinkedIn scraping");
                    failures.linkedin.push({
                        handle: creator.handle, name: creator.name,
                        niche: creator.niche, reason: "All accounts blacklisted",
                    });
                    continue;
                }

                try {
                    // SCRAPE (with pool rotation + fallback)
                    const result = await scrapeWithPool(profileUrl, maxLinkedInPostsPerCreator);

                    if (!result || result.posts.length === 0) {
                        const reason = result ? "0 posts returned" : "All account pairs failed";
                        failures.linkedin.push({ handle: creator.handle, name: creator.name, niche: creator.niche, reason });
                        continue;
                    }

                    const posts = result.posts;

                    // NORMALIZE
                    let normalized = posts.map((p) =>
                        normalizeLinkedInPost(p, creator, creator.niche)
                    );
                    normalized = deduplicateByContentHash(normalized);
                    normalized = filterByEngagement(normalized, minEngagementScore);

                    if (normalized.length === 0) {
                        console.log(`      → ${posts.length} posts fetched, 0 passed filters`);
                        successes.linkedin++;
                        continue;
                    }

                    // CLASSIFY
                    const classified = await classifyBatch(normalized);

                    // EMBED
                    const embedded = await embedPosts(classified);

                    // UPSERT
                    const vectors = preparePineconeVectors(embedded);
                    if (vectors.length > 0 && !dryRun) {
                        await upsertTopPosts(vectors);
                    }

                    allVectors.push(...vectors);
                    for (const post of embedded) {
                        byNiche[post.niche] = (byNiche[post.niche] || 0) + 1;
                        byPlatform.linkedin++;
                    }

                    successes.linkedin++;
                    console.log(`      ✅ ${posts.length} posts → ${vectors.length} vectors ${dryRun ? "(dry run)" : "upserted"} [${result.pair.label}]`);
                } catch (error) {
                    console.error(`      ❌ Error: ${error.message}`);
                    failures.linkedin.push({ handle: creator.handle, name: creator.name, niche: creator.niche, reason: error.message });
                }

                // Delay between LinkedIn profiles (5-10 seconds — LinkedIn is stricter)
                if (i < creators.linkedin.length - 1) {
                    const delay = 5000 + Math.random() * 5000;
                    await sleep(delay);
                }
            }

            // Cleanup all cached clients
            for (const [, client] of clientCache) {
                try { await client.cleanup(); } catch { }
            }

            // Print pool health summary
            pool.printStatus();
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  Summary
    // ══════════════════════════════════════════════════════════════
    const totalVectors = allVectors.length;
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const totalFailures = failures.x.length + failures.linkedin.length;

    if (!dryRun && totalVectors > 0) {
        const stats = await getStats();
        console.log(`\n   Pinecone top-posts count: ${stats.topPostsCount}`);
    }

    console.log("\n" + "═".repeat(50));
    console.log("✅ SEED COMPLETE");
    console.log("═".repeat(50));
    console.log(`Total vectors: ${totalVectors}`);
    console.log(`By platform: X=${byPlatform.x}, LinkedIn=${byPlatform.linkedin}`);
    console.log(`By niche: ${JSON.stringify(byNiche)}`);
    console.log(`Scrape success: X=${successes.x}/${creators.x.length}, LinkedIn=${successes.linkedin}/${creators.linkedin.length}`);
    console.log(`Time elapsed: ${elapsed} minutes`);
    console.log(`Dry run: ${dryRun}`);

    if (totalFailures > 0) {
        console.log(`\n⚠️  ${totalFailures} creators failed:`);
        if (failures.x.length > 0) {
            console.log(`  X failures (${failures.x.length}):`);
            for (const f of failures.x) console.log(`    - @${f.handle} (${f.niche}): ${f.reason}`);
        }
        if (failures.linkedin.length > 0) {
            console.log(`  LinkedIn failures (${failures.linkedin.length}):`);
            for (const f of failures.linkedin) console.log(`    - ${f.name || f.handle} (${f.niche}): ${f.reason}`);
        }
    }

    // Save results
    if (!dryRun) {
        const outputDir = path.join(__dirname, "..", "data", "output");
        await fs.mkdir(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, `seed-${new Date().toISOString().slice(0, 10)}.json`);
        await fs.writeFile(
            outputPath,
            JSON.stringify(
                {
                    total: totalVectors, byNiche, byPlatform,
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

    return { total: totalVectors, byNiche, byPlatform, failures };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
