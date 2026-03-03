/**
 * Normalizer
 * 
 * Transforms raw scraped data from X and LinkedIn into a common schema.
 * Handles engagement score calculation, thread detection, and deduplication.
 */

import crypto from "crypto";

/**
 * Normalize a raw X tweet into the common schema
 * @param {object} rawTweet - Raw tweet from XClient
 * @param {object} creator - Creator info from creators.json
 * @param {object} profile - Profile data from XClient.fetchCreatorProfile
 * @param {string} niche - Niche key from creators.json
 */
export function normalizeXTweet(rawTweet, creator, profile, niche) {
    const followerCount = profile?.followersCount || creator.followers || 1;

    return {
        id: `tp_x_${rawTweet.id}`,
        content: rawTweet.text,
        platform: "x",
        authorName: creator.name,
        authorHandle: rawTweet.username || creator.handle,
        authorFollowerCount: followerCount,
        likes: rawTweet.likes,
        comments: rawTweet.replies,
        shares: rawTweet.retweets,
        impressions: rawTweet.impressions,
        engagementScore: calculateEngagementScore({
            likes: rawTweet.likes,
            comments: rawTweet.replies,
            shares: rawTweet.retweets,
            impressions: rawTweet.impressions,
            followerCount,
        }),
        wordCount: countWords(rawTweet.text),
        postedAt: rawTweet.timeParsed
            ? new Date(rawTweet.timeParsed).toISOString()
            : null,
        // Filled by classifier later:
        format: null,
        hookType: null,
        niche: niche,
        hasCta: null,
        // Internal metadata:
        contentHash: hashContent(rawTweet.text),
        media: rawTweet.media || null,
        _raw: {
            conversationId: rawTweet.conversationId,
            inReplyToStatusId: rawTweet.inReplyToStatusId,
            userId: rawTweet.userId,
        },
    };
}

/**
 * Normalize a raw LinkedIn post into the common schema
 * @param {object} rawPost - Raw post from LinkedInClient
 * @param {object} creator - Creator info from creators.json
 * @param {string} niche - Niche key from creators.json
 */
export function normalizeLinkedInPost(rawPost, creator, niche) {
    const followerCount = creator.followers || 1;

    return {
        id: `tp_li_${extractLinkedInId(rawPost.urn)}`,
        content: rawPost.text,
        platform: "linkedin",
        authorName: creator.name,
        authorHandle: creator.handle,
        authorFollowerCount: followerCount,
        likes: rawPost.totalReactions,
        comments: rawPost.commentCount,
        shares: rawPost.repostCount,
        impressions: null, // LinkedIn doesn't expose this publicly
        engagementScore: calculateEngagementScore({
            likes: rawPost.totalReactions,
            comments: rawPost.commentCount,
            shares: rawPost.repostCount,
            impressions: null,
            followerCount,
        }),
        wordCount: countWords(rawPost.text),
        postedAt: rawPost.postedAt || null,
        format: null,
        hookType: null,
        niche: niche,
        hasCta: null,
        contentHash: hashContent(rawPost.text),
        media: rawPost.media || null,
        _raw: { urn: rawPost.urn, type: rawPost.type },
    };
}

/**
 * Detect and merge X threads into single entries
 * @param {Array} normalizedTweets - Array of normalized tweets
 * @returns {Array} Tweets with threads merged
 */
export function detectAndMergeThreads(normalizedTweets) {
    // Group tweets by conversationId + author
    const threadGroups = new Map();
    const standalone = [];

    for (const tweet of normalizedTweets) {
        const convId = tweet._raw?.conversationId;
        const userId = tweet._raw?.userId;

        if (!convId || !userId) {
            standalone.push(tweet);
            continue;
        }

        const key = `${convId}_${userId}`;
        if (!threadGroups.has(key)) {
            threadGroups.set(key, []);
        }
        threadGroups.get(key).push(tweet);
    }

    const result = [...standalone];

    for (const [, group] of threadGroups) {
        if (group.length === 1) {
            // Not a thread, just a single tweet
            result.push(group[0]);
            continue;
        }

        // It's a thread — merge
        // Sort by timestamp (or by inReplyTo chain)
        group.sort((a, b) => {
            const dateA = a.postedAt ? new Date(a.postedAt) : 0;
            const dateB = b.postedAt ? new Date(b.postedAt) : 0;
            return dateA - dateB;
        });

        const mergedContent = group.map((t) => t.content).join("\n\n---\n\n");
        const firstTweet = group[0];
        const totalLikes = group.reduce((sum, t) => sum + t.likes, 0);
        const totalComments = group.reduce((sum, t) => sum + t.comments, 0);
        const totalShares = group.reduce((sum, t) => sum + t.shares, 0);
        const totalImpressions = group.reduce((sum, t) => sum + (t.impressions || 0), 0);

        result.push({
            ...firstTweet,
            id: `tp_x_thread_${firstTweet._raw?.conversationId || firstTweet.id}`,
            content: mergedContent,
            likes: totalLikes,
            comments: totalComments,
            shares: totalShares,
            impressions: totalImpressions || null,
            engagementScore: calculateEngagementScore({
                likes: totalLikes,
                comments: totalComments,
                shares: totalShares,
                impressions: totalImpressions || null,
                followerCount: firstTweet.authorFollowerCount,
            }),
            wordCount: countWords(mergedContent),
            format: "thread", // Pre-set format for threads
            contentHash: hashContent(mergedContent),
            _raw: {
                ...firstTweet._raw,
                threadTweetIds: group.map((t) => t.id),
                threadLength: group.length,
            },
        });
    }

    return result;
}

/**
 * Calculate normalized engagement score
 * 
 * Formula:
 *   If impressions available: (likes + comments*3 + shares*2) / impressions * 10000
 *   If no impressions:        (likes + comments*3 + shares*2) / followers * 10000
 * 
 * Score of 100 = average, 200+ = good, 500+ = viral
 */
export function calculateEngagementScore({ likes, comments, shares, impressions, followerCount }) {
    const weightedEngagement =
        (likes || 0) * 1 + (comments || 0) * 3 + (shares || 0) * 2;

    const denominator = impressions || followerCount || 1;
    return Math.round((weightedEngagement / denominator) * 10000);
}

/**
 * Deduplicate posts by content hash
 */
export function deduplicateByContentHash(posts) {
    const seen = new Set();
    return posts.filter((post) => {
        if (seen.has(post.contentHash)) return false;
        seen.add(post.contentHash);
        return true;
    });
}

/**
 * Filter posts by minimum engagement score
 */
export function filterByEngagement(posts, minScore = 100) {
    return posts.filter((p) => p.engagementScore >= minScore);
}

// --- Helpers ---

function countWords(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).length;
}

function hashContent(text) {
    if (!text) return "";
    return crypto.createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

function extractLinkedInId(urn) {
    if (!urn) return `unknown_${Date.now()}`;
    // urn:li:activity:1234567890 → 1234567890
    const match = urn.match(/(\d+)$/);
    return match ? match[1] : urn.replace(/[^a-zA-Z0-9]/g, "_");
}
