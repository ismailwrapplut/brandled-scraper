/**
 * X/Twitter Client (Hybrid: Direct API + Playwright fallback)
 * 
 * PRIMARY: Uses direct GraphQL API calls with cursor-based pagination.
 *   - Much faster (seconds instead of minutes)
 *   - Can fetch thousands of tweets
 *   - Requires auth_token cookie
 * 
 * FALLBACK: Scroll-based Playwright interception if API approach fails.
 * 
 * Cost: $0
 */

import { chromium } from "playwright";
import fs from "fs";

const SCROLL_DELAY_MIN = 1500;
const SCROLL_DELAY_MAX = 3000;
const PAGE_LOAD_TIMEOUT = 30000;

// Rate limit config
const RATE_LIMIT_INITIAL_WAIT_MS = 60_000;   // 60s first backoff
const RATE_LIMIT_MAX_WAIT_MS = 300_000;       // 5 min max backoff
const MAX_RETRIES_PER_REQUEST = 3;
const DELAY_BETWEEN_CREATORS_NORMAL = [3000, 7000];   // [min, max] ms
const DELAY_BETWEEN_CREATORS_THROTTLED = [15000, 30000];

// X's public bearer token (embedded in their JS bundle, same for every user)
const X_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// X's GraphQL query IDs (stable, embedded in their JS bundle)
const GQL_QUERY_IDS = {
    UserByScreenName: "xmU6X_CKVnQ5lSrCbAmJsg",
    UserTweets: "E3opETHurmVJflFsUBVuUQ",
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class XClient {
    constructor() {
        this.browser = null;
        this.context = null;
        // Cached session cookies (avoid opening a page per creator)
        this._cachedHeaders = null;
        this._cachedHeadersExpiry = 0;
        // Rate limit state
        this._rateLimitBackoff = RATE_LIMIT_INITIAL_WAIT_MS;
        this._consecutiveRateLimits = 0;
        this._isThrottled = false;
    }

    /**
     * Get the recommended delay between creators based on rate limit state
     */
    getCreatorDelay() {
        const [min, max] = this._isThrottled
            ? DELAY_BETWEEN_CREATORS_THROTTLED
            : DELAY_BETWEEN_CREATORS_NORMAL;
        return min + Math.random() * (max - min);
    }

    /**
     * Initialize the browser
     */
    async initialize() {
        const launchOptions = {
            headless: true,
            args: [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
            ],
        };

        // Add proxy if configured (for local dev to avoid IP bans)
        if (process.env.PROXY_SERVER) {
            launchOptions.proxy = {
                server: process.env.PROXY_SERVER,
                username: process.env.PROXY_USERNAME || "",
                password: process.env.PROXY_PASSWORD || "",
            };
            console.log(`  🔀 Using proxy: ${process.env.PROXY_SERVER}`);
        }

        this.browser = await chromium.launch(launchOptions);

        this.context = await this.browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            viewport: { width: 1920, height: 1080 },
            locale: "en-US",
        });

        // 1. Check for manual auth_token cookie (most reliable method)
        if (process.env.TWITTER_AUTH_TOKEN) {
            await this.context.addCookies([{
                name: "auth_token",
                value: process.env.TWITTER_AUTH_TOKEN.trim().replace(/^["']|["']$/g, ""),
                domain: ".x.com",
                path: "/",
                httpOnly: true,
                secure: true,
            }]);
            console.log("✅ X client initialized (authenticated via TWITTER_AUTH_TOKEN)");
            return;
        }

        // 2. Check for saved session cookies from a previous automated login
        const authPath = './x-auth.json';
        if (fs.existsSync(authPath)) {
            try {
                const cookies = JSON.parse(fs.readFileSync(authPath, 'utf8'));
                if (cookies.some(c => c.name === 'auth_token')) {
                    await this.context.addCookies(cookies);
                    console.log("✅ X client initialized (authenticated via saved session)");
                    return;
                }
            } catch (e) {
                console.log("  ⚠️ Failed to parse x-auth.json, will re-login.");
            }
        }

        // 3. Automated Login Flow (can be brittle due to X captchas)
        if (process.env.TWITTER_SCRAPER_USERNAME && process.env.TWITTER_SCRAPER_PASSWORD) {
            console.log("  🔑 No saved session found. Attempting automated login to X...");
            await this._loginToX(process.env.TWITTER_SCRAPER_USERNAME, process.env.TWITTER_SCRAPER_PASSWORD, process.env.TWITTER_SCRAPER_EMAIL);
        } else {
            console.log("✅ X client initialized (Playwright, anonymous mode)");
        }
    }

    /**
     * Automated login to X and save session
     */
    async _loginToX(username, password, email) {
        const page = await this.context.newPage();
        try {
            await page.goto('https://twitter.com/i/flow/login', { waitUntil: "domcontentloaded" });
            await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
            await page.fill('input[autocomplete="username"]', username);
            await page.keyboard.press('Enter');

            try {
                await page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', { timeout: 5000 });
                console.log("  ⚠️ X asked for unusual login verification. Entering email...");
                if (email) {
                    await page.fill('input[data-testid="ocfEnterTextTextInput"]', email);
                    await page.keyboard.press('Enter');
                }
            } catch (e) { /* No extra verification needed */ }

            await page.waitForSelector('input[name="password"]', { timeout: 15000 });
            await page.waitForTimeout(1000);
            await page.fill('input[name="password"]', password);
            await page.keyboard.press('Enter');
            await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 15000 });

            const cookies = await this.context.cookies();
            fs.writeFileSync('./x-auth.json', JSON.stringify(cookies, null, 2));
            console.log("  ✅ Successfully logged into X and saved session.");
        } catch (error) {
            console.error("  ❌ Failed to log into X automatically:", error.message);
            console.log("     Continuing in anonymous mode. (Consider adding TWITTER_AUTH_TOKEN to .env)");
        } finally {
            await page.close();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MAIN: fetchCreatorTweets — tries API first, falls back to scroll
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Fetch tweets from a creator's profile
     * @param {string} handle - X handle (without @)
     * @param {number} maxTweets - Maximum tweets to fetch
     * @returns {Promise<Array>} Array of tweet objects
     */
    async fetchCreatorTweets(handle, maxTweets = 30) {
        if (!this.browser) {
            throw new Error("XClient not initialized. Call initialize() first.");
        }

        this._lastFetchedProfile = null;

        // Try the fast direct API approach first
        try {
            const result = await this._fetchTweetsViaAPI(handle, maxTweets);
            if (result.length > 0) {
                return result;
            }
            console.log(`  ⚠️ API approach returned 0 tweets, falling back to scroll method...`);
        } catch (apiErr) {
            console.log(`  ⚠️ API approach failed (${apiErr.message}), falling back to scroll method...`);
        }

        // Fallback to scroll-based approach
        return this._fetchTweetsViaScroll(handle, maxTweets);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PRIMARY: Direct GraphQL API with cursor-based pagination
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Get or refresh cached API headers (avoids opening a page per creator)
     */
    async _getAPIHeaders() {
        if (this._cachedHeaders && Date.now() < this._cachedHeadersExpiry) {
            return this._cachedHeaders;
        }

        console.log(`  🔗 Refreshing session cookies...`);
        const page = await this.context.newPage();
        try {
            await page.goto(`https://x.com/home`, {
                waitUntil: "domcontentloaded",
                timeout: PAGE_LOAD_TIMEOUT,
            });
            await page.waitForTimeout(3000);
        } catch (e) {
            // Even if page load times out, cookies may still be set
        }
        await page.close();

        const cookies = await this.context.cookies("https://x.com");
        const authToken = cookies.find(c => c.name === "auth_token")?.value;
        const ct0 = cookies.find(c => c.name === "ct0")?.value;

        if (!authToken || !ct0) {
            throw new Error("Missing auth_token or ct0 cookie — cannot make API calls");
        }

        this._cachedHeaders = {
            "Authorization": `Bearer ${decodeURIComponent(X_BEARER_TOKEN)}`,
            "Cookie": `auth_token=${authToken}; ct0=${ct0}`,
            "X-Csrf-Token": ct0,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "X-Twitter-Active-User": "yes",
            "X-Twitter-Auth-Type": "OAuth2Session",
            "X-Twitter-Client-Language": "en",
        };
        // Cache for 10 minutes
        this._cachedHeadersExpiry = Date.now() + 10 * 60 * 1000;
        return this._cachedHeaders;
    }

    async _fetchTweetsViaAPI(handle, maxTweets) {
        // Step 1: Get API headers (cached; only visits a page on first call / every 10 min)
        console.log(`  🔗 @${handle}: Fetching session cookies...`);
        const headers = await this._getAPIHeaders();

        // Step 2: Resolve screen name → user rest_id
        console.log(`  🔍 @${handle}: Resolving user ID...`);
        const userResult = await this._gqlRequest(headers, "UserByScreenName", {
            screen_name: handle,
            withSafetyModeUserFields: true,
        }, {
            hidden_profile_subscriptions_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
        });

        const userObj = userResult?.data?.user?.result;
        const userId = userObj?.rest_id;
        if (!userId) throw new Error("Could not resolve user ID");

        // Capture profile data
        const legacy = userObj?.legacy || {};
        const imageUrl = legacy.profile_image_url_https || userObj?.profile_image_url_https || "";
        this._lastFetchedProfile = {
            id: userId,
            username: legacy.screen_name || handle,
            name: legacy.name || "",
            bio: legacy.description || "",
            image: imageUrl
                ? imageUrl.replace('_normal', '').replace('_200x200', '').replace('_400x400', '')
                : (this._lastFetchedProfile?.image || ""),
            followersCount: legacy.followers_count || 0,
            followingCount: legacy.friends_count || 0,
            tweetsCount: legacy.statuses_count || 0,
            isVerified: legacy.verified || userObj?.is_blue_verified || false,
        };
        console.log(`  📸 @${handle} profile: name="${this._lastFetchedProfile.name}", image=${this._lastFetchedProfile.image ? 'found' : 'MISSING'}, followers=${this._lastFetchedProfile.followersCount}`);

        // Step 3: Paginate through UserTweets
        console.log(`  📡 @${handle}: Fetching tweets via API (target: ${maxTweets})...`);
        const allTweets = [];
        let cursor = null;
        let pageNum = 0;
        const maxPages = Math.ceil(maxTweets / 15) + 10; // ~15-20 tweets per page, with buffer

        while (allTweets.length < maxTweets && pageNum < maxPages) {
            pageNum++;

            const variables = {
                userId: userId,
                count: 20,
                includePromotedContent: false,
                withQuickPromoteEligibilityTweetFields: true,
                withVoice: true,
                withV2Timeline: true,
            };
            if (cursor) variables.cursor = cursor;

            let timelineResult;
            try {
                timelineResult = await this._gqlRequest(headers, "UserTweets", variables, {
                    responsive_web_graphql_exclude_directive_enabled: true,
                    verified_phone_label_enabled: false,
                    responsive_web_graphql_timeline_navigation_enabled: true,
                    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
                    creator_subscriptions_tweet_preview_api_enabled: true,
                    tweetypie_unmention_optimization_enabled: true,
                    responsive_web_edit_tweet_api_enabled: true,
                    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
                    view_counts_everywhere_api_enabled: true,
                    longform_notetweets_consumption_enabled: true,
                    responsive_web_twitter_article_tweet_consumption_enabled: true,
                    tweet_awards_web_tipping_enabled: false,
                    freedom_of_speech_not_reach_fetch_enabled: true,
                    standardized_nudges_misinfo: true,
                    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
                    rweb_video_timestamps_enabled: true,
                    longform_notetweets_rich_text_read_enabled: true,
                    longform_notetweets_inline_media_enabled: true,
                    responsive_web_enhance_cards_enabled: false,
                });
            } catch (fetchErr) {
                console.log(`  ⚠️ Page ${pageNum} fetch failed: ${fetchErr.message}`);
                break;
            }

            const tweets = this._extractTweetsFromGraphQL(timelineResult, handle);
            if (tweets.length === 0 && pageNum > 1) {
                console.log(`  📊 @${handle}: No more tweets on page ${pageNum}, stopping.`);
                break;
            }

            allTweets.push(...tweets);

            // Extract the next cursor
            cursor = this._extractCursor(timelineResult);
            if (!cursor) {
                console.log(`  📊 @${handle}: No more pages (end of timeline).`);
                break;
            }

            if (pageNum % 10 === 0) {
                console.log(`  📡 @${handle}: ${allTweets.length} tweets after ${pageNum} API pages...`);
            }

            // Small delay between API calls to be respectful
            const apiDelay = this._isThrottled ? 2000 + Math.random() * 3000 : 500 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, apiDelay));
        }

        // Dedup and sort
        const deduped = this._dedup(allTweets);
        deduped.sort((a, b) => new Date(b.timeParsed || 0) - new Date(a.timeParsed || 0));

        console.log(`  ✅ @${handle}: ${deduped.length} unique tweets fetched via API (${pageNum} pages)`);
        return deduped.slice(0, maxTweets);
    }

    /**
     * Make a GraphQL request to X's internal API
     */
    /**
     * Make a GraphQL request with automatic retry + rate-limit backoff
     */
    async _gqlRequest(headers, operationName, variables, features) {
        const queryId = GQL_QUERY_IDS[operationName];
        if (!queryId) throw new Error(`Unknown operation: ${operationName}`);

        const params = new URLSearchParams({
            variables: JSON.stringify(variables),
            features: JSON.stringify(features),
        });

        const url = `https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;

        for (let attempt = 1; attempt <= MAX_RETRIES_PER_REQUEST; attempt++) {
            const resp = await fetch(url, { method: "GET", headers });

            if (resp.ok) {
                // Reset backoff on success
                this._consecutiveRateLimits = 0;
                this._rateLimitBackoff = RATE_LIMIT_INITIAL_WAIT_MS;
                this._isThrottled = false;
                return resp.json();
            }

            if (resp.status === 429) {
                this._consecutiveRateLimits++;
                this._isThrottled = true;

                // Check for Retry-After header
                const retryAfter = resp.headers.get("retry-after");
                let waitMs = this._rateLimitBackoff;
                if (retryAfter) {
                    const retrySeconds = parseInt(retryAfter, 10);
                    if (!isNaN(retrySeconds)) waitMs = retrySeconds * 1000;
                }
                waitMs = Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS);

                if (attempt < MAX_RETRIES_PER_REQUEST) {
                    console.log(`  ⏳ Rate limited (429) on ${operationName}, waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES_PER_REQUEST}...`);
                    await sleep(waitMs);
                    // Exponential backoff for next time
                    this._rateLimitBackoff = Math.min(this._rateLimitBackoff * 2, RATE_LIMIT_MAX_WAIT_MS);
                    continue;
                }
            }

            // Non-429 error or final attempt
            const text = await resp.text().catch(() => "");
            if (attempt < MAX_RETRIES_PER_REQUEST && resp.status >= 500) {
                console.log(`  ⏳ Server error (${resp.status}) on ${operationName}, retrying in 5s (${attempt + 1}/${MAX_RETRIES_PER_REQUEST})...`);
                await sleep(5000);
                continue;
            }

            throw new Error(`GraphQL ${operationName} ${resp.status}: ${text.substring(0, 300)}`);
        }
    }

    /**
     * Extract the "bottom" cursor from a GraphQL timeline response for pagination
     */
    _extractCursor(json) {
        try {
            const instructions =
                json?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
                json?.data?.user?.result?.timeline?.timeline?.instructions ||
                [];

            for (const instruction of instructions) {
                const entries = instruction?.entries || [];
                for (const entry of entries) {
                    if (entry?.entryId?.startsWith("cursor-bottom")) {
                        return entry?.content?.value || null;
                    }
                }
                // Also check replaceEntry instructions
                if (instruction?.type === "TimelineReplaceEntry") {
                    const entry = instruction?.entry;
                    if (entry?.entryId?.startsWith("cursor-bottom")) {
                        return entry?.content?.value || null;
                    }
                }
            }
        } catch { }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  FALLBACK: Scroll-based Playwright interception
    // ═══════════════════════════════════════════════════════════════════

    async _fetchTweetsViaScroll(handle, maxTweets) {
        const page = await this.context.newPage();
        const interceptedTweets = [];
        this._lastFetchedProfile = this._lastFetchedProfile || null;

        try {
            page.on("response", async (response) => {
                const url = response.url();

                if (url.includes("/UserByScreenName")) {
                    try {
                        const json = await response.json();
                        const result = json?.data?.user?.result;
                        const legacy = result?.legacy;
                        if (result || legacy) {
                            const imageUrl =
                                legacy?.profile_image_url_https ||
                                result?.profile_image_url_https ||
                                result?.legacy?.profile_image_url_https || "";
                            const user = legacy || result || {};
                            this._lastFetchedProfile = {
                                id: result?.rest_id || null,
                                username: user.screen_name || handle,
                                name: user.name || "",
                                bio: user.description || "",
                                image: imageUrl ? imageUrl.replace('_normal', '').replace('_200x200', '').replace('_400x400', '') : "",
                                followersCount: user.followers_count || 0,
                                followingCount: user.friends_count || 0,
                                tweetsCount: user.statuses_count || 0,
                                isVerified: user.verified || result?.is_blue_verified || false,
                            };
                            console.log(`  📸 X profile intercepted: name="${this._lastFetchedProfile.name}", image=${this._lastFetchedProfile.image ? 'found' : 'MISSING'}`);
                        }
                    } catch { /* skip */ }
                }

                if (
                    url.includes("/UserTweets") ||
                    url.includes("TweetResultsByRestId") ||
                    url.includes("/timeline/profile")
                ) {
                    try {
                        const json = await response.json();
                        const tweets = this._extractTweetsFromGraphQL(json, handle);
                        interceptedTweets.push(...tweets);
                    } catch { /* skip */ }
                }
            });

            await page.goto(`https://x.com/${handle}`, {
                waitUntil: "domcontentloaded",
                timeout: PAGE_LOAD_TIMEOUT,
            });
            await page.waitForTimeout(3000);

            const notFound = await page.$('div[data-testid="empty_state_header_text"]');
            if (notFound) {
                console.log(`  ⚠️  @${handle} — profile not found or suspended`);
                await page.close();
                return [];
            }

            let scrollAttempts = 0;
            const maxScrolls = Math.min(Math.ceil(maxTweets / 1.5) + 10, 500);
            let lastCount = 0;
            let staleScrolls = 0;

            while (scrollAttempts < maxScrolls && interceptedTweets.length < maxTweets) {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
                const delay = SCROLL_DELAY_MIN + Math.random() * (SCROLL_DELAY_MAX - SCROLL_DELAY_MIN);
                await page.waitForTimeout(delay);

                if (interceptedTweets.length === lastCount) {
                    staleScrolls++;
                    if (staleScrolls >= 10) break;
                } else {
                    staleScrolls = 0;
                    lastCount = interceptedTweets.length;
                }
                scrollAttempts++;
                if (scrollAttempts % 20 === 0) {
                    console.log(`  📜 @${handle}: ${interceptedTweets.length} tweets after ${scrollAttempts} scrolls (stale: ${staleScrolls})...`);
                }
            }

            console.log(`  📊 @${handle} scroll complete: ${scrollAttempts} scrolls, ${interceptedTweets.length} tweets`);

            if (interceptedTweets.length === 0) {
                const domTweets = await this._parseDOMFallback(page, handle);
                return this._dedup(domTweets).slice(0, maxTweets);
            }

            const deduped = this._dedup(interceptedTweets);
            deduped.sort((a, b) => new Date(b.timeParsed || 0) - new Date(a.timeParsed || 0));

            if (this._lastFetchedProfile && !this._lastFetchedProfile.image) {
                try {
                    const domImage = await page
                        .$eval('img[src*="profile_images"]',
                            (e) => e.getAttribute("src")?.replace('_normal', '').replace('_200x200', '').replace('_400x400', '') || "")
                        .catch(() => "");
                    if (domImage) {
                        this._lastFetchedProfile.image = domImage;
                        console.log(`  📸 X profile image recovered from DOM: ${domImage.substring(0, 60)}...`);
                    }
                } catch { /* skip */ }
            }

            return deduped.slice(0, maxTweets);
        } catch (error) {
            console.error(`Error fetching tweets for @${handle}:`, error.message);
            return [];
        } finally {
            await page.close();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Profile fetching
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Fetch a user's public profile info
     */
    async fetchCreatorProfile(handle) {
        if (!this.browser) {
            throw new Error("XClient not initialized. Call initialize() first.");
        }

        // If we already captured profile during fetchCreatorTweets, return it
        if (this._lastFetchedProfile && this._lastFetchedProfile.username?.toLowerCase() === handle?.toLowerCase()) {
            const p = this._lastFetchedProfile;
            console.log(`  ✅ X profile for @${handle} captured during tweet fetch (image: ${p.image ? 'yes' : 'no'})`);
            return p;
        }

        const page = await this.context.newPage();
        try {
            // Try API interception first
            let profileData = null;

            page.on("response", async (response) => {
                if (response.url().includes("/UserByScreenName")) {
                    try {
                        const json = await response.json();
                        const result = json?.data?.user?.result;
                        const legacy = result?.legacy;
                        if (result) {
                            const imageUrl =
                                legacy?.profile_image_url_https ||
                                result?.profile_image_url_https || "";
                            const user = legacy || result || {};
                            profileData = {
                                id: result?.rest_id || null,
                                username: user.screen_name || handle,
                                name: user.name || "",
                                bio: user.description || "",
                                image: imageUrl ? imageUrl.replace('_normal', '').replace('_200x200', '').replace('_400x400', '') : "",
                                followersCount: user.followers_count || 0,
                                followingCount: user.friends_count || 0,
                                tweetsCount: user.statuses_count || 0,
                                isVerified: user.verified || result?.is_blue_verified || false,
                            };
                        }
                    } catch { /* skip */ }
                }
            });

            await page.goto(`https://x.com/${handle}`, {
                waitUntil: "domcontentloaded",
                timeout: PAGE_LOAD_TIMEOUT,
            });
            await page.waitForTimeout(3000);

            if (profileData) {
                // Recover image from DOM if missing
                if (!profileData.image) {
                    try {
                        const domImage = await page.$eval(
                            'img[src*="profile_images"]',
                            (e) => e.getAttribute("src")?.replace('_normal', '').replace('_200x200', '').replace('_400x400', '') || ""
                        );
                        if (domImage) profileData.image = domImage;
                    } catch { /* skip */ }
                }
                return profileData;
            }

            // DOM fallback
            return await this._parseProfileFromDOM(page, handle);
        } catch (error) {
            console.error(`Error fetching profile for @${handle}:`, error.message);
            return null;
        } finally {
            await page.close();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  GraphQL response parsing
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Extract tweets from X's GraphQL API response
     */
    _extractTweetsFromGraphQL(json, handle) {
        const tweets = [];

        try {
            const instructions =
                json?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
                json?.data?.user?.result?.timeline?.timeline?.instructions ||
                [];

            for (const instruction of instructions) {
                const entries = instruction?.entries || [];

                for (const entry of entries) {
                    // Direct tweet entry
                    const directResult =
                        entry?.content?.itemContent?.tweet_results?.result;
                    if (directResult) {
                        const tweet = this._parseTweetResult(directResult, handle);
                        if (tweet) tweets.push(tweet);
                        continue;
                    }

                    // Conversation module (threads) — group into single post
                    const items = entry?.content?.items || [];
                    if (items.length > 0) {
                        const threadTweets = [];
                        for (const item of items) {
                            const itemResult = item?.item?.itemContent?.tweet_results?.result;
                            if (itemResult) {
                                const tweet = this._parseTweetResult(itemResult, handle);
                                if (tweet) threadTweets.push(tweet);
                            }
                        }

                        if (threadTweets.length > 0) {
                            const firstTweet = threadTweets[0];
                            if (threadTweets.length > 1) {
                                firstTweet.text = threadTweets.map(t => t.text).join('\n\n---\n\n');
                                const allMedia = threadTweets.flatMap(t => t.media || []);
                                firstTweet.media = [...new Map(allMedia.map(m => [m.url, m])).values()];
                            }
                            tweets.push(firstTweet);
                        }
                    }
                }
            }
        } catch {
            // Partial parse is fine
        }

        return tweets;
    }

    /**
     * Parse a single tweet result from GraphQL
     */
    _parseTweetResult(result, handle) {
        try {
            const tweetData = result.__typename === "TweetWithVisibilityResults"
                ? result.tweet
                : result;

            const legacy = tweetData?.legacy;
            if (!legacy) return null;

            const text = legacy.full_text || "";

            // Skip retweets
            if (text.startsWith("RT @")) return null;

            // Skip completely empty tweets
            const textWithoutUrls = text.replace(/https?:\/\/\S+/g, "").trim();
            if (textWithoutUrls.length === 0 && !legacy.extended_entities?.media?.length) return null;

            // Skip replies (unless self-reply / thread)
            const isReply = !!legacy.in_reply_to_status_id_str;
            const replyToUser = legacy.in_reply_to_screen_name?.toLowerCase();
            const isSelfReply = replyToUser === handle?.toLowerCase();

            if (isReply && !isSelfReply) return null;

            // Extract media
            const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
            const media = mediaEntities.map((m) => {
                if (m.type === 'video' || m.type === 'animated_gif') {
                    const variants = m.video_info?.variants || [];
                    const mp4s = variants.filter(v => v.content_type === 'video/mp4');
                    const best = mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
                    return {
                        type: m.type === 'animated_gif' ? 'gif' : 'video',
                        url: best?.url || m.media_url_https || '',
                        preview: m.media_url_https || '',
                        width: m.original_info?.width || 0,
                        height: m.original_info?.height || 0,
                        durationMs: m.video_info?.duration_millis || 0,
                    };
                }
                return {
                    type: 'image',
                    url: m.media_url_https || '',
                    preview: m.media_url_https || '',
                    width: m.original_info?.width || 0,
                    height: m.original_info?.height || 0,
                };
            });

            return {
                id: legacy.id_str || tweetData.rest_id,
                text: text,
                timeParsed: legacy.created_at ? new Date(legacy.created_at) : null,
                timestamp: legacy.created_at
                    ? Math.floor(new Date(legacy.created_at).getTime() / 1000)
                    : null,
                likes: legacy.favorite_count || 0,
                retweets: legacy.retweet_count || 0,
                replies: legacy.reply_count || 0,
                views: tweetData?.views?.count
                    ? parseInt(tweetData.views.count, 10)
                    : 0,
                bookmarkCount: legacy.bookmark_count || 0,
                conversationId: legacy.conversation_id_str || null,
                inReplyToStatusId: legacy.in_reply_to_status_id_str || null,
                isRetweet: false,
                isReply: isReply,
                isSelfReply: isSelfReply,
                username: handle,
                userId: legacy.user_id_str || null,
                hashtags: (legacy.entities?.hashtags || []).map((h) => h.text),
                urls: (legacy.entities?.urls || []).map((u) => u.expanded_url),
                media: media.length > 0 ? media : null,
            };
        } catch {
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DOM fallback helpers
    // ═══════════════════════════════════════════════════════════════════

    async _parseDOMFallback(page, handle) {
        const tweets = [];
        try {
            await page.waitForSelector('article[data-testid="tweet"]', { timeout: 5000 }).catch(() => { });
            const tweetElements = await page.$$('article[data-testid="tweet"]');

            for (const el of tweetElements) {
                try {
                    const text = await el
                        .$eval('div[data-testid="tweetText"]', (e) => e.textContent?.trim() || "")
                        .catch(() => "");
                    if (!text || text.length < 20) continue;
                    if (text.startsWith("RT @")) continue;

                    const likes = await this._extractMetric(el, 'button[data-testid="like"]');
                    const retweets = await this._extractMetric(el, 'button[data-testid="retweet"]');
                    const replies = await this._extractMetric(el, 'button[data-testid="reply"]');
                    const views = await this._extractViewCount(el);

                    const timeEl = await el.$("time");
                    const datetime = timeEl ? await timeEl.getAttribute("datetime") : null;

                    const media = [];
                    const imgEls = await el.$$('div[data-testid="tweetPhoto"] img');
                    for (const img of imgEls) {
                        const src = await img.getAttribute('src').catch(() => '');
                        if (src && src.includes('pbs.twimg.com')) {
                            media.push({ type: 'image', url: src, preview: src });
                        }
                    }
                    const videoEl = await el.$('video');
                    if (videoEl) {
                        const poster = await videoEl.getAttribute('poster').catch(() => '');
                        media.push({ type: 'video', url: '', preview: poster || '' });
                    }

                    tweets.push({
                        id: `dom_${Date.now()}_${tweets.length}`,
                        text,
                        timeParsed: datetime ? new Date(datetime) : null,
                        timestamp: datetime ? Math.floor(new Date(datetime).getTime() / 1000) : null,
                        likes, retweets, replies, views,
                        bookmarkCount: 0, conversationId: null, inReplyToStatusId: null,
                        isRetweet: false, isReply: false, isSelfReply: false,
                        username: handle, userId: null, hashtags: [], urls: [],
                        media: media.length > 0 ? media : null,
                    });
                } catch { continue; }
            }
        } catch (error) {
            console.error("DOM fallback failed:", error.message);
        }
        return tweets;
    }

    async _extractMetric(tweetEl, selector) {
        try {
            const btn = await tweetEl.$(selector);
            if (!btn) return 0;
            const label = await btn.getAttribute("aria-label");
            if (!label) return 0;
            const match = label.match(/([\d,]+)/);
            return match ? parseInt(match[1].replace(/,/g, ""), 10) : 0;
        } catch { return 0; }
    }

    async _extractViewCount(tweetEl) {
        try {
            const analyticsLink = await tweetEl.$('a[href*="/analytics"]');
            if (!analyticsLink) return 0;
            const label = await analyticsLink.getAttribute("aria-label");
            if (!label) return 0;
            const match = label.match(/([\d,]+)/);
            return match ? parseInt(match[1].replace(/,/g, ""), 10) : 0;
        } catch { return 0; }
    }

    async _parseProfileFromDOM(page, handle) {
        try {
            const name = await page
                .$eval('div[data-testid="UserName"] span', (e) => e.textContent?.trim() || "")
                .catch(() => handle);
            const bio = await page
                .$eval('div[data-testid="UserDescription"]', (e) => e.textContent?.trim() || "")
                .catch(() => "");
            let followersCount = 0;
            try {
                const followersLink = await page.$(`a[href="/${handle}/verified_followers"], a[href="/${handle}/followers"]`);
                if (followersLink) {
                    const text = await followersLink.textContent();
                    followersCount = this._parseCompactNumber(text);
                }
            } catch { /* skip */ }
            const image = await page
                .$eval('img[src*="profile_images"]', (e) => e.getAttribute("src")?.replace('_normal', '') || "")
                .catch(() => "");
            return { id: null, username: handle, name, bio, image, followersCount, followingCount: 0, tweetsCount: 0, isVerified: false };
        } catch {
            return { id: null, username: handle, name: handle, bio: "", image: "", followersCount: 0, followingCount: 0, tweetsCount: 0, isVerified: false };
        }
    }

    _parseCompactNumber(text) {
        if (!text) return 0;
        const cleaned = text.replace(/[^0-9.KMBkmb]/g, "").trim();
        const match = cleaned.match(/([\d.]+)\s*([KMBkmb])?/);
        if (!match) return 0;
        const num = parseFloat(match[1]);
        const suffix = (match[2] || "").toUpperCase();
        if (suffix === "K") return Math.round(num * 1000);
        if (suffix === "M") return Math.round(num * 1000000);
        if (suffix === "B") return Math.round(num * 1000000000);
        return Math.round(num);
    }

    _dedup(tweets) {
        const seen = new Set();
        return tweets.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
        });
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
        }
    }
}
