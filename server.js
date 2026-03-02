/**
 * Brandled Scraper — REST API Server
 *
 * Exposes the LinkedIn and X scraping clients as REST endpoints
 * so the main Brandled app can trigger scraping during onboarding.
 *
 * Endpoints:
 *   POST /api/scrape/linkedin  — Scrape a LinkedIn profile's posts
 *   POST /api/scrape/x         — Scrape an X/Twitter profile's tweets
 *   GET  /api/health            — Health check
 */

import "dotenv/config";              // must be FIRST — loads .env before any other module reads process.env
import express from "express";
import { LinkedInClient } from "./clients/linkedin-client.js";
import { LinkedInAccountPool } from "./clients/linkedin-account-pool.js";
import { XClient } from "./clients/x-client.js";
import { seedTopPosts } from "./jobs/seed.js";

const app = express();
app.use(express.json());

// Shared LinkedIn account pool — loaded once at startup
const linkedInPool = new LinkedInAccountPool().load();

const PORT = process.env.SCRAPER_PORT || 3001;
const API_SECRET = process.env.SCRAPER_API_SECRET || "brandled-scraper-secret";

// Simple auth middleware
function authenticate(req, res, next) {
    const token = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
    if (token !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// Health check
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", service: "brandled-scraper" });
});

/**
 * POST /api/scrape/linkedin
 * Body: { username: string, maxPosts?: number }
 * Returns: { posts: [...], profile: {...} }
 */
app.post("/api/scrape/linkedin", authenticate, async (req, res) => {
    const { username, maxPosts = 30 } = req.body;

    if (!username) {
        return res.status(400).json({ error: "username is required" });
    }

    const profileUrl = `https://www.linkedin.com/in/${username}`;
    const healthyPairs = linkedInPool.allHealthy();

    if (healthyPairs.length === 0) {
        return res.status(503).json({ error: "No healthy LinkedIn accounts available" });
    }

    // Try each healthy account pair until one succeeds
    for (const pair of healthyPairs) {
        const client = new LinkedInClient(pair);
        try {
            console.log(`[Scraper] Starting LinkedIn scrape for: ${username} [${pair.label}]`);
            await client.initialize();

            const posts = await client.fetchCreatorPosts(profileUrl, maxPosts);

            linkedInPool.reportSuccess(pair);
            console.log(`[Scraper] LinkedIn scrape complete: ${posts.length} posts for ${username} [${pair.label}]`);

            return res.json({
                success: true,
                platform: "linkedin",
                username,
                postsCount: posts.length,
                posts,
                _account: pair.label,
            });
        } catch (error) {
            console.error(`[Scraper] LinkedIn scrape error for ${username} [${pair.label}]:`, error.message);
            linkedInPool.reportFailure(pair, error.message);
        } finally {
            await client.cleanup();
        }
    }

    // All pairs failed
    res.status(500).json({
        error: "Scraping failed",
        message: "All LinkedIn account pairs failed for this request",
    });
});

/**
 * POST /api/scrape/x
 * Body: { handle: string, maxTweets?: number }
 * Returns: { tweets: [...], profile: {...} }
 */
app.post("/api/scrape/x", authenticate, async (req, res) => {
    const { handle, maxTweets = 30 } = req.body;

    if (!handle) {
        return res.status(400).json({ error: "handle is required" });
    }

    const client = new XClient();

    try {
        console.log(`[Scraper] Starting X scrape for: @${handle}`);
        await client.initialize();

        // Fetch tweets FIRST so profile is captured during page visit
        const tweets = await client.fetchCreatorTweets(handle, maxTweets);
        const profile = await client.fetchCreatorProfile(handle);

        console.log(`[Scraper] X scrape complete: ${tweets.length} tweets for @${handle}`);

        res.json({
            success: true,
            platform: "x",
            handle,
            tweetsCount: tweets.length,
            tweets,
            profile,
        });
    } catch (error) {
        console.error(`[Scraper] X scrape error for @${handle}:`, error.message);
        res.status(500).json({
            error: "Scraping failed",
            message: error.message,
        });
    } finally {
        await client.cleanup();
    }
});

/**
 * POST /api/scrape/both
 * Body: { linkedinUsername?: string, xHandle?: string, maxPosts?: number }
 * Returns: { linkedin: {...}, x: {...} }
 */
app.post("/api/scrape/both", authenticate, async (req, res) => {
    const { linkedinUsername, xHandle, maxPosts = 30 } = req.body;

    if (!linkedinUsername && !xHandle) {
        return res.status(400).json({ error: "At least one of linkedinUsername or xHandle is required" });
    }

    const results = { linkedin: null, x: null };

    // Scrape LinkedIn if username provided (with pool rotation + fallback)
    if (linkedinUsername) {
        const healthyPairs = linkedInPool.allHealthy();
        let linkedinDone = false;

        for (const pair of healthyPairs) {
            if (linkedinDone) break;
            const liClient = new LinkedInClient(pair);
            try {
                await liClient.initialize();
                const profileUrl = `https://www.linkedin.com/in/${linkedinUsername}`;
                const [posts, profile] = await Promise.all([
                    liClient.fetchCreatorPosts(profileUrl, maxPosts),
                    liClient.fetchCreatorProfile(profileUrl),
                ]);
                linkedInPool.reportSuccess(pair);
                results.linkedin = {
                    success: true,
                    username: linkedinUsername,
                    postsCount: posts.length,
                    posts,
                    profile,
                    _account: pair.label,
                };
                console.log(`[Scraper] LinkedIn: ${posts.length} posts for ${linkedinUsername} [${pair.label}]`);
                linkedinDone = true;
            } catch (error) {
                linkedInPool.reportFailure(pair, error.message);
                results.linkedin = { success: false, error: error.message };
                console.error(`[Scraper] LinkedIn error [${pair.label}]:`, error.message);
            } finally {
                await liClient.cleanup();
            }
        }

        if (healthyPairs.length === 0) {
            results.linkedin = { success: false, error: "No healthy LinkedIn accounts available" };
        }
    }

    // Scrape X if handle provided
    if (xHandle) {
        const xClient = new XClient();
        try {
            await xClient.initialize();
            // IMPORTANT: Fetch tweets FIRST so profile data (including image) is
            // captured from the GraphQL interception during the page visit.
            // Then fetchCreatorProfile will return the cached profile instantly.
            const tweets = await xClient.fetchCreatorTweets(xHandle, maxPosts);
            const profile = await xClient.fetchCreatorProfile(xHandle);
            results.x = {
                success: true,
                handle: xHandle,
                tweetsCount: tweets.length,
                tweets,
                profile,
            };
            console.log(`[Scraper] X: ${tweets.length} tweets for @${xHandle}`);
        } catch (error) {
            results.x = { success: false, error: error.message };
            console.error(`[Scraper] X error:`, error.message);
        } finally {
            await xClient.cleanup();
        }
    }

    res.json({
        success: true,
        ...results,
    });
});

/**
 * POST /api/seed
 * Body: { niche?: string, platform?: string, limit?: number, dryRun?: boolean, skipTo?: number }
 * Triggers the full seed pipeline (scrape → classify → embed → upsert)
 * Runs in background and returns immediately with a job ID
 */
let _seedRunning = false;
let _seedResult = null;

app.post("/api/seed", authenticate, async (req, res) => {
    if (_seedRunning) {
        return res.status(409).json({ error: "Seed is already running" });
    }

    const { niche, platform, limit, dryRun, skipTo } = req.body || {};

    _seedRunning = true;
    _seedResult = null;

    // Run in background — don't block the HTTP response
    const startTime = Date.now();
    seedTopPosts({ niche, platform, limit, dryRun, skipTo })
        .then((result) => {
            _seedResult = { ...result, elapsed: ((Date.now() - startTime) / 1000 / 60).toFixed(1) + " min", finishedAt: new Date().toISOString() };
            console.log("[Seed] Completed:", JSON.stringify(_seedResult));
        })
        .catch((err) => {
            _seedResult = { error: err.message, finishedAt: new Date().toISOString() };
            console.error("[Seed] Failed:", err.message);
        })
        .finally(() => {
            _seedRunning = false;
        });

    res.json({ success: true, message: "Seed pipeline started in background", options: { niche, platform, limit, dryRun, skipTo } });
});

/**
 * GET /api/seed/status
 * Returns whether the seed is running + last result
 */
app.get("/api/seed/status", authenticate, (req, res) => {
    res.json({ running: _seedRunning, lastResult: _seedResult });
});

/**
 * GET /api/debug/x?handle=justinwelsh
 * Quick diagnostic: shows raw API response structure from X
 */
app.get("/api/debug/x", authenticate, async (req, res) => {
    const handle = req.query.handle || "justinwelsh";
    const client = new XClient();
    
    try {
        await client.initialize();
        
        // Get headers
        const headers = await client._getAPIHeaders();
        
        // Resolve user
        let userResult;
        try {
            userResult = await client._gqlRequest(headers, "UserByScreenName", {
                screen_name: handle,
                withGrokTranslatedBio: false,
            }, {
                hidden_profile_subscriptions_enabled: true,
                profile_label_improvements_pcf_label_in_post_enabled: true,
                responsive_web_profile_redirect_enabled: false,
                rweb_tipjar_consumption_enabled: false,
                verified_phone_label_enabled: true,
                subscriptions_verification_info_is_identity_verified_enabled: true,
                subscriptions_verification_info_verified_since_enabled: true,
                highlights_tweets_tab_ui_enabled: true,
                responsive_web_twitter_article_notes_tab_enabled: true,
                subscriptions_feature_can_gift_premium: true,
                creator_subscriptions_tweet_preview_api_enabled: true,
                responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
                responsive_web_graphql_timeline_navigation_enabled: true,
            }, {
                withPayments: false,
                withAuxiliaryUserLabels: true,
            });
        } catch (e) {
            return res.json({ error: "UserByScreenName failed", message: e.message });
        }
        
        const userObj = userResult?.data?.user?.result;
        const userId = userObj?.rest_id;
        const legacy = userObj?.legacy || {};
        
        // Fetch one page of tweets
        let timelineResult;
        try {
            timelineResult = await client._gqlRequest(headers, "UserTweets", {
                userId,
                count: 5,
                includePromotedContent: false,
                withQuickPromoteEligibilityTweetFields: true,
                withVoice: true,
                withV2Timeline: true,
            }, {
                rweb_video_screen_enabled: false,
                profile_label_improvements_pcf_label_in_post_enabled: true,
                responsive_web_profile_redirect_enabled: false,
                rweb_tipjar_consumption_enabled: false,
                verified_phone_label_enabled: true,
                creator_subscriptions_tweet_preview_api_enabled: true,
                responsive_web_graphql_timeline_navigation_enabled: true,
                responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
                premium_content_api_read_enabled: false,
                communities_web_enable_tweet_community_results_fetch: true,
                c9s_tweet_anatomy_moderator_badge_enabled: true,
                responsive_web_grok_analyze_button_fetch_trends_enabled: false,
                responsive_web_grok_analyze_post_followups_enabled: true,
                responsive_web_jetfuel_frame: true,
                responsive_web_grok_share_attachment_enabled: true,
                responsive_web_grok_annotations_enabled: true,
                articles_preview_enabled: true,
                responsive_web_edit_tweet_api_enabled: true,
                graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
                view_counts_everywhere_api_enabled: true,
                longform_notetweets_consumption_enabled: true,
                responsive_web_twitter_article_tweet_consumption_enabled: true,
                tweet_awards_web_tipping_enabled: false,
                responsive_web_grok_show_grok_translated_post: false,
                responsive_web_grok_analysis_button_from_backend: true,
                post_ctas_fetch_enabled: true,
                freedom_of_speech_not_reach_fetch_enabled: true,
                standardized_nudges_misinfo: true,
                tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
                longform_notetweets_rich_text_read_enabled: true,
                longform_notetweets_inline_media_enabled: true,
                responsive_web_grok_image_annotation_enabled: true,
                responsive_web_grok_imagine_annotation_enabled: true,
                responsive_web_grok_community_note_auto_translation_is_enabled: false,
                responsive_web_enhance_cards_enabled: false,
            }, {
                withPayments: false,
                withAuxiliaryUserLabels: true,
                withArticleRichContentState: true,
                withArticlePlainText: false,
                withGrokAnalyze: false,
                withDisallowedReplyControls: false,
            });
        } catch (e) {
            return res.json({
                user: { id: userId, name: legacy.name, followers: legacy.followers_count, typename: userObj?.__typename },
                error: "UserTweets failed", message: e.message,
            });
        }
        
        // Analyze the response
        const instructions = timelineResult?.data?.user?.result?.timeline_v2?.timeline?.instructions || 
                             timelineResult?.data?.user?.result?.timeline?.timeline?.instructions || [];
        const entries = instructions.flatMap(i => i?.entries || []);
        const tweetEntries = entries.filter(e => e?.entryId?.startsWith("tweet-"));
        const resultKeys = Object.keys(timelineResult?.data?.user?.result || {});
        const typename = timelineResult?.data?.user?.result?.__typename;
        
        res.json({
            user: {
                id: userId,
                name: legacy.name,
                screenName: legacy.screen_name,
                followers: legacy.followers_count,
                tweetsCount: legacy.statuses_count,
                typename: userObj?.__typename,
            },
            timeline: {
                typename,
                resultKeys,
                instructionCount: instructions.length,
                instructionTypes: instructions.map(i => i?.type),
                totalEntries: entries.length,
                tweetEntries: tweetEntries.length,
                entryIds: entries.slice(0, 10).map(e => e?.entryId),
                // Show first tweet text as proof
                sampleTweet: tweetEntries[0] ? 
                    (tweetEntries[0]?.content?.itemContent?.tweet_results?.result?.legacy?.full_text || "").slice(0, 200) : null,
            },
            // Raw response for deep debugging (truncated)
            rawResponsePreview: JSON.stringify(timelineResult).slice(0, 2000),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        await client.cleanup();
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Brandled Scraper API running on http://localhost:${PORT}`);
    console.log(`   POST /api/scrape/linkedin  — Scrape LinkedIn posts`);
    console.log(`   POST /api/scrape/x         — Scrape X/Twitter tweets`);
    console.log(`   POST /api/scrape/both      — Scrape both platforms`);
    console.log(`   POST /api/seed             — Trigger full seed pipeline`);
    console.log(`   GET  /api/health           — Health check\n`);
});
