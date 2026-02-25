#!/usr/bin/env node

/**
 * CLI Entry Point: Weekly Refresh
 * 
 * Usage:
 *   node scripts/refresh.js                        # Full refresh (all niches)
 *   node scripts/refresh.js --niche ai_tech        # Refresh one niche
 *   node scripts/refresh.js --prune 180            # Remove posts older than 180 days
 */

import "dotenv/config";
import { seedTopPosts } from "../jobs/seed.js";

const args = process.argv.slice(2);

function getArg(name) {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    if (index + 1 >= args.length) return true;
    const next = args[index + 1];
    if (next.startsWith("--")) return true;
    return next;
}

console.log("🔄 Weekly Top Posts Refresh");
console.log("─".repeat(50));

const options = {
    niche: getArg("niche") || null,
    platform: null,
    limit: null,
    dryRun: args.includes("--dry-run"),
    maxTweetsPerCreator: 15,        // Only recent tweets
    maxLinkedInPostsPerCreator: 10, // Only recent posts
    minEngagementScore: 100,        // Higher bar for weekly refresh
};

try {
    const result = await seedTopPosts(options);
    console.log(`\n🔄 Refresh complete: ${result.total} posts updated.`);
    process.exit(0);
} catch (error) {
    console.error("\n❌ Refresh failed:", error);
    process.exit(1);
}
