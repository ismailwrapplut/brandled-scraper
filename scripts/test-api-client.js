/**
 * Test: LinkedIn Direct API (no browser)
 * Usage: node scripts/test-api-client.js [profileSlug] [count|all]
 * Examples:
 *   node scripts/test-api-client.js whyismail        → 10 posts
 *   node scripts/test-api-client.js whyismail 50     → 50 posts
 *   node scripts/test-api-client.js whyismail all    → ALL posts
 *   node scripts/test-api-client.js whyismail 500    → 500 posts (onboarding mode)
 */

import 'dotenv/config';
import { LinkedInApiClient } from '../clients/linkedin-api-client.js';
import { LinkedInAccountPool } from '../clients/linkedin-account-pool.js';

const profileSlug = process.argv[2] || 'whyismail';
const countArg = process.argv[3] || '10';
const maxPosts = countArg === 'all' ? 10000 : Math.max(1, parseInt(countArg) || 10);
const fetchAll = countArg === 'all';

console.log('═'.repeat(62));
console.log('  LinkedIn Direct API — Full Scrape Test');
console.log('═'.repeat(62));
console.log(`  Profile : ${profileSlug}`);
console.log(`  Posts   : ${fetchAll ? 'ALL' : maxPosts}`);
console.log('');

const pool = new LinkedInAccountPool();
pool.load();

if (pool.size === 0) {
    console.error('❌ No LinkedIn accounts found in .env');
    process.exit(1);
}

console.log(`📦 Pool: ${pool.size} account(s)\n`);

let success = false;

for (let attempt = 0; attempt < pool.size; attempt++) {
    const pair = pool.next();
    const client = new LinkedInApiClient(pair);

    try {
        client.initialize();

        // Quick auth check
        const authCheck = await client._apiGet('https://www.linkedin.com/voyager/api/me');
        if (authCheck.status === 401 || authCheck.status === 403) {
            console.log(`  ❌ [${pair.label}] Cookie expired (${authCheck.status})\n`);
            pool.markFailed(pair.label, `Cookie ${authCheck.status}`);
            continue;
        }
        if (authCheck.ok) {
            const me = authCheck.data?.included?.find(i => i.firstName);
            console.log(`  ✅ Auth: ${me ? `${me.firstName} ${me.lastName || ''}`.trim() : 'logged in'}\n`);
        }

        // ── Full scrape: profile + posts ──────────────────────────────
        const startTime = Date.now();
        const { profile, posts } = await client.fetchCreatorFull(profileSlug, maxPosts);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // ── Print Profile ─────────────────────────────────────────────
        console.log('\n' + '─'.repeat(62));
        console.log('  👤 PROFILE');
        console.log('─'.repeat(62));
        console.log(`  Name       : ${profile.name}`);
        console.log(`  Headline   : ${profile.headline || '—'}`);
        console.log(`  Followers  : ${profile.followersCount?.toLocaleString() || '—'}`);
        console.log(`  Connections: ${profile.connectionsCount?.toLocaleString() || '—'}`);
        console.log(`  Photo URL  : ${profile.profileImageUrl ? profile.profileImageUrl.substring(0, 80) + '…' : '—'}`);

        if (!posts || posts.length === 0) {
            console.log(`\n  ⚠️ No posts returned for ${profileSlug}`);
            pool.markFailed(pair.label, 'No posts');
            continue;
        }

        // ── Print Posts summary ───────────────────────────────────────
        console.log('\n' + '─'.repeat(62));
        console.log(`  📝 POSTS  (${posts.length} total, fetched in ${elapsed}s)`);
        console.log('─'.repeat(62));

        const previewCount = Math.min(posts.length, fetchAll ? 10 : 5);
        posts.slice(0, previewCount).forEach((p, i) => {
            const preview = p.text.replace(/\n/g, ' ').substring(0, 88);
            const date = p.postedAt ? new Date(p.postedAt).toLocaleDateString('en-GB') : '??/??/??';
            const type = p.type !== 'text' ? ` [${p.type}]` : '';
            console.log(`\n  [${i + 1}] ${date}${type}`);
            console.log(`  👍 ${p.totalReactions}  💬 ${p.commentCount}  🔁 ${p.repostCount}`);
            console.log(`  "${preview}${preview.length >= 88 ? '…' : '"}"`);
                });

        if (posts.length > previewCount) {
            console.log(`\n  … and ${ posts.length - previewCount } more posts`);
        }

        // Stats breakdown
        const byType = posts.reduce((acc, p) => {
            acc[p.type] = (acc[p.type] || 0) + 1;
            return acc;
        }, {});
        const oldest = posts.at(-1)?.postedAt ? new Date(posts.at(-1).postedAt).toLocaleDateString('en-GB') : '?';
        const newest = posts[0]?.postedAt     ? new Date(posts[0].postedAt).toLocaleDateString('en-GB')     : '?';
        console.log('\n' + '─'.repeat(62));
        console.log('  📊 STATS');
        console.log(`  Date range : ${ oldest } → ${ newest }`);
        console.log(`  By type    : ${ Object.entries(byType).map(([t, c]) => `${t}:${c}`).join(', ') }`);
        console.log(`  Avg 👍     : ${(posts.reduce((s, p) => s + p.totalReactions, 0) / posts.length).toFixed(1)}`);
        console.log(`  Avg 💬     : ${(posts.reduce((s, p) => s + p.commentCount, 0) / posts.length).toFixed(1)}`);

        success = true;
        break;
    } catch (err) {
        console.log(`  ❌ Error: ${ err.message } \n`);
        pool.markFailed(pair.label, err.message);
    } finally {
        client.cleanup();
    }
}

console.log('\n' + '═'.repeat(62));
console.log(success ? '  🎉 Scrape complete!' : '  ❌ All accounts failed — refresh li_at cookies');
console.log('═'.repeat(62) + '\n');

pool.status();
