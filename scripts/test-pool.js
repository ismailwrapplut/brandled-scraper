#!/usr/bin/env node

/**
 * Test: LinkedIn Account Pool + Scraping
 * 
 * Tests pool loading, rotation, and a real scrape of a LinkedIn profile.
 */

import "dotenv/config";
import { LinkedInAccountPool } from "../clients/linkedin-account-pool.js";
import { LinkedInClient } from "../clients/linkedin-client.js";

const TARGET = "whyismail";

async function main() {
    console.log("═".repeat(60));
    console.log("  LinkedIn Account Pool — Test");
    console.log("═".repeat(60));

    // 1. Load pool
    const pool = new LinkedInAccountPool().load();

    if (pool.size === 0) {
        console.error("\n❌ No accounts found in pool! Check your .env");
        process.exit(1);
    }

    console.log(`\nPool has ${pool.size} pair(s), ${pool.healthyCount} healthy`);

    // 2. Demonstrate rotation — call next() a few times
    console.log("\n── Rotation demo (calling next() 6 times) ──");
    for (let i = 0; i < 6; i++) {
        const pair = pool.next();
        console.log(`  next() → [${pair.label}]  proxy=${pair.proxyServer || "none"}`);
    }

    // 3. Real scrape with fallback
    console.log(`\n── Scraping LinkedIn: ${TARGET} (with fallback) ──`);

    const healthyPairs = pool.allHealthy();
    let success = false;

    for (const pair of healthyPairs) {
        console.log(`\n  Trying [${pair.label}]...`);
        const client = new LinkedInClient(pair);

        try {
            await client.initialize();

            const profileUrl = `https://www.linkedin.com/in/${TARGET}`;
            const posts = await client.fetchCreatorPosts(profileUrl, 10);

            if (posts.length === 0) {
                throw new Error("0 posts returned — treating as failure for pool rotation");
            }

            pool.reportSuccess(pair);
            success = true;

            console.log(`\n✅ SUCCESS via [${pair.label}] — ${posts.length} posts`);
            for (const p of posts.slice(0, 5)) {
                const preview = p.text?.substring(0, 80)?.replace(/\n/g, " ") || "(no text)";
                console.log(`   • [${p.totalReactions} reactions] ${preview}...`);
            }
            if (posts.length > 5) console.log(`   ... and ${posts.length - 5} more`);

            await client.cleanup();
            break;
        } catch (err) {
            console.log(`  ❌ [${pair.label}] failed: ${err.message}`);
            pool.reportFailure(pair, err.message);
            await client.cleanup();
        }
    }

    if (!success) {
        console.log("\n❌ All account pairs failed!");
    }

    // 4. Print pool health
    pool.printStatus();
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
