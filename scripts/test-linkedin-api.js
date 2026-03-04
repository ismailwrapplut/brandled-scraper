#!/usr/bin/env node
/**
 * Test script for LinkedInApiClient (pure HTTP, no browser)
 *
 * Usage:
 *   node scripts/test-linkedin-api.js <username> [maxPosts]
 *
 * Example:
 *   node scripts/test-linkedin-api.js whyismail 3
 */

import "dotenv/config";
import { LinkedInAccountPool } from "../clients/linkedin-account-pool.js";
import { LinkedInApiClient } from "../clients/linkedin-api-client.js";

const username = process.argv[2] || "whyismail";
const maxPosts = parseInt(process.argv[3] || "3", 10);

// Load first healthy account pair from the pool
const pool = new LinkedInAccountPool().load();
const pairs = pool.allHealthy();

if (pairs.length === 0) {
    console.error("❌ No healthy LinkedIn account pairs found in .env");
    console.error("   Make sure LINKEDIN_POOL_1_LI_AT and LINKEDIN_POOL_1_JSESSIONID are set.");
    process.exit(1);
}

const pair = pairs[0];
console.log(`\n🔗 Testing LinkedInApiClient with account [${pair.label}]`);
console.log(`   Username: ${username}`);
console.log(`   Max posts: ${maxPosts}\n`);

const client = new LinkedInApiClient(pair);
client.initialize();

try {
    // 1. Fetch just the profile first
    console.log("👤 Fetching profile...");
    const profile = await client.fetchCreatorProfile(`https://www.linkedin.com/in/${username}`);
    console.log("\n📋 Profile:");
    console.log(JSON.stringify(profile, null, 2));

    // 2. Fetch posts
    console.log(`\n📝 Fetching up to ${maxPosts} posts...`);
    const { posts } = await client.fetchCreatorFull(`https://www.linkedin.com/in/${username}`, maxPosts);
    console.log(`\n✅ ${posts.length} post(s) returned:\n`);
    console.log(JSON.stringify(posts.slice(0, maxPosts), null, 2));

} catch (err) {
    console.error("\n❌ Error:", err.message);
} finally {
    client.cleanup();
}
