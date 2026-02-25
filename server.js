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

import express from "express";
import { LinkedInClient } from "./clients/linkedin-client.js";
import { XClient } from "./clients/x-client.js";
import { seedTopPosts } from "./jobs/seed.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

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

    const client = new LinkedInClient();

    try {
        console.log(`[Scraper] Starting LinkedIn scrape for: ${username}`);
        await client.initialize();

        const profileUrl = `https://www.linkedin.com/in/${username}`;
        const posts = await client.fetchCreatorPosts(profileUrl, maxPosts);

        console.log(`[Scraper] LinkedIn scrape complete: ${posts.length} posts for ${username}`);

        res.json({
            success: true,
            platform: "linkedin",
            username,
            postsCount: posts.length,
            posts,
        });
    } catch (error) {
        console.error(`[Scraper] LinkedIn scrape error for ${username}:`, error.message);
        res.status(500).json({
            error: "Scraping failed",
            message: error.message,
        });
    } finally {
        await client.cleanup();
    }
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

    // Scrape LinkedIn if username provided
    if (linkedinUsername) {
        const liClient = new LinkedInClient();
        try {
            await liClient.initialize();
            const profileUrl = `https://www.linkedin.com/in/${linkedinUsername}`;
            const [posts, profile] = await Promise.all([
                liClient.fetchCreatorPosts(profileUrl, maxPosts),
                liClient.fetchCreatorProfile(profileUrl),
            ]);
            results.linkedin = {
                success: true,
                username: linkedinUsername,
                postsCount: posts.length,
                posts,
                profile,
            };
            console.log(`[Scraper] LinkedIn: ${posts.length} posts for ${linkedinUsername}`);
        } catch (error) {
            results.linkedin = { success: false, error: error.message };
            console.error(`[Scraper] LinkedIn error:`, error.message);
        } finally {
            await liClient.cleanup();
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

app.listen(PORT, () => {
    console.log(`\n🚀 Brandled Scraper API running on http://localhost:${PORT}`);
    console.log(`   POST /api/scrape/linkedin  — Scrape LinkedIn posts`);
    console.log(`   POST /api/scrape/x         — Scrape X/Twitter tweets`);
    console.log(`   POST /api/scrape/both      — Scrape both platforms`);
    console.log(`   POST /api/seed             — Trigger full seed pipeline`);
    console.log(`   GET  /api/health           — Health check\n`);
});
