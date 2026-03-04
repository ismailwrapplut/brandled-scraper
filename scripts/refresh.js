#!/usr/bin/env node

/**
 * CLI Entry Point: Daily/Weekly Refresh
 * 
 * Usage:
 *   node scripts/refresh.js                        # Daily refresh (last 2 days)
 *   node scripts/refresh.js --days 7               # Weekly refresh (last 7 days)
 *   node scripts/refresh.js --niche ai_tech        # Refresh one niche
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

console.log(`🔄 Refreshing Top Posts (Daily/Scheduled)`);
console.log("─".repeat(50));

const options = {
    niche: getArg("niche") || null,
    platform: null,
    limit: null,
    dryRun: args.includes("--dry-run"),
    maxDaysOld: getArg("days") ? parseInt(getArg("days"), 10) : 2, // 2 days is ideal for a daily cron to catch late-day stragglers
    maxTweetsPerCreator: 15,        // Enough to cover 2 days
    maxLinkedInPostsPerCreator: 10, // Enough to cover 2 days
    minEngagementScore: 100,        // Higher bar for routine refresh
};

try {
    const result = await seedTopPosts(options);
    console.log(`\n🔄 Refresh complete: ${result.total} posts updated.`);
    process.exit(0);
} catch (error) {
    console.error("\n❌ Refresh failed:", error);
    process.exit(1);
}
