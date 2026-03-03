#!/usr/bin/env node

/**
 * CLI Entry Point: Seed Top Posts
 * 
 * Usage:
 *   node scripts/seed.js                           # Full seed
 *   node scripts/seed.js --niche saas              # One niche only
 *   node scripts/seed.js --platform x              # X only
 *   node scripts/seed.js --limit 2                 # 2 creators per niche (testing)
 *   node scripts/seed.js --dry-run                 # Process but don't upsert
 *   node scripts/seed.js --min-score 200           # Higher quality threshold
 *   node scripts/seed.js --limit 2 --dry-run       # Quick test
 *   node scripts/seed.js --skip-to 50              # Skip first 49 creators per platform
 */

import "dotenv/config";
import { seedTopPosts } from "../jobs/seed.js";

// Parse CLI arguments
const args = process.argv.slice(2);

function getArg(name) {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    if (index + 1 >= args.length) return true; // Flag with no value
    const next = args[index + 1];
    if (next.startsWith("--")) return true; // Flag with no value
    return next;
}

const options = {
    niche: getArg("niche") || null,
    platform: getArg("platform") || null,
    limit: getArg("limit") ? parseInt(getArg("limit"), 10) : null,
    skipTo: getArg("skip-to") ? parseInt(getArg("skip-to"), 10) : 0,
    dryRun: args.includes("--dry-run"),
    minEngagementScore: getArg("min-score") ? parseInt(getArg("min-score"), 10) : 50,
};

// Validate
const validNiches = ["saas", "marketing", "ai_tech", "startup", "creator_economy", "leadership"];
if (options.niche && !validNiches.includes(options.niche)) {
    console.error(`Invalid niche: ${options.niche}. Valid: ${validNiches.join(", ")}`);
    process.exit(1);
}

if (options.platform && !["x", "linkedin"].includes(options.platform)) {
    console.error(`Invalid platform: ${options.platform}. Valid: x, linkedin`);
    process.exit(1);
}

// Run
try {
    const result = await seedTopPosts(options);
    process.exit(result.total > 0 ? 0 : 1);
} catch (error) {
    console.error("\n❌ Seed failed:", error);
    process.exit(1);
}