/**
 * Test: LinkedIn Direct API (no browser)
 * Usage: node scripts/test-api-client.js [profileSlug]
 * Example: node scripts/test-api-client.js whyismail
 */

import 'dotenv/config';
import { LinkedInApiClient } from '../clients/linkedin-api-client.js';
import { LinkedInAccountPool } from '../clients/linkedin-account-pool.js';

const profileSlug = process.argv[2] || 'whyismail';

console.log('═'.repeat(60));
console.log('  LinkedIn Direct API Client — Test');
console.log('═'.repeat(60));
console.log(`  Target: ${profileSlug}`);
console.log('');

const pool = new LinkedInAccountPool();
pool.load();

if (pool.size === 0) {
    console.error('❌ No LinkedIn accounts found in .env');
    process.exit(1);
}

console.log(`📦 Pool: ${pool.size} account(s) loaded\n`);

// Try each account with fallback
let success = false;
for (let attempt = 0; attempt < pool.size; attempt++) {
    const pair = pool.next();
    console.log(`── Trying [${pair.label}]... ──`);

    const client = new LinkedInApiClient(pair);

    try {
        client.initialize();

        // Quick auth check first
        console.log(`  🔎 Checking auth...`);
        const authCheck = await client._apiGet(
            `https://www.linkedin.com/voyager/api/me`
        );

        if (authCheck.status === 401 || authCheck.status === 403) {
            console.log(`  ❌ Cookie expired (${authCheck.status}) — update LINKEDIN_POOL_${attempt + 1}_LI_AT\n`);
            pool.markFailed(pair.label, `Cookie ${authCheck.status}`);
            continue;
        }

        if (!authCheck.ok) {
            console.log(`  ⚠️ Auth check returned ${authCheck.status}, continuing anyway...\n`);
        } else {
            const name = authCheck.data?.included?.find(i => i.firstName)?.firstName || 'unknown';
            console.log(`  ✅ Auth OK — logged in as: ${name || 'LinkedIn user'}\n`);
        }

        // Fetch posts
        console.log(`  📡 Fetching posts for "${profileSlug}"...`);
        const startTime = Date.now();
        const posts = await client.fetchCreatorPosts(profileSlug, 10);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (!posts || posts.length === 0) {
            console.log(`  ⚠️ No posts returned for ${profileSlug}\n`);
            pool.markFailed(pair.label, 'No posts returned');
            continue;
        }

        console.log(`\n✅ SUCCESS! ${posts.length} posts in ${elapsed}s\n`);
        console.log('─'.repeat(60));

        posts.slice(0, 5).forEach((p, i) => {
            const preview = p.text?.replace(/\n/g, ' ').substring(0, 90);
            const date = p.postedAt ? new Date(p.postedAt).toLocaleDateString() : 'unknown';
            console.log(`\n[${i + 1}] ${date} | 👍 ${p.totalReactions} 💬 ${p.commentCount} 🔁 ${p.repostCount}`);
            console.log(`    ${preview}${preview?.length >= 90 ? '...' : ''}`);
        });

        success = true;
        break;
    } catch (err) {
        console.log(`  ❌ Error: ${err.message}\n`);
        pool.markFailed(pair.label, err.message);
    } finally {
        client.cleanup();
    }
}

console.log('\n─'.repeat(60));
if (!success) {
    console.log('\n❌ All accounts failed. Check your li_at cookies.');
} else {
    console.log('\n🎉 Direct API scraping works! No browser needed.');
}

pool.status();
