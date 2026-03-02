/**
 * LinkedIn Client — Robust Multi-Strategy Scraper
 *
 * THREE-LAYER FALLBACK:
 *   1. Voyager GraphQL API  (voyagerFeedDashProfileUpdates — fastest, most data)
 *   2. Voyager REST Activity API  (alternate Voyager endpoint)
 *   3. Scroll-based DOM parsing  (slowest, last resort)
 *
 * KEY DESIGN PRINCIPLE:
 *   All API calls use page.evaluate(() => fetch(...)) — NOT context.request.get().
 *   This sends requests through Chrome's real fetch engine, giving the correct
 *   TLS/JA3 fingerprint that LinkedIn expects. context.request.get() has a
 *   different fingerprint and gets timed out / blocked by LinkedIn's fraud scoring.
 *
 * RESILIENCE:
 *   - Persistent session page (this._page) kept alive for all API calls
 *   - Cookie re-injection on login redirects (up to 3 attempts)
 *   - Multiple session entry URLs (/feed, /mynetwork, /in/me)
 *   - Session page crash detection and re-establishment
 *   - Pool-aware: accepts injected credentials from LinkedInAccountPool
 */

import { chromium } from "playwright";

const SCROLL_DELAY_MIN = 2500;
const SCROLL_DELAY_MAX = 5000;
const NAV_TIMEOUT = 30000;
const FETCH_TIMEOUT = 20000;   // timeout for page.evaluate fetch() calls
const MAX_SESSION_RETRIES = 3;

const SESSION_ENTRY_URLS = [
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/mynetwork/",
    "https://www.linkedin.com/in/me/",
];

export class LinkedInClient {
    /**
     * @param {object} [accountPair] — from LinkedInAccountPool. Falls back to env vars if null.
     */
    constructor(accountPair = null) {
        this.browser = null;
        this.context = null;
        this._page = null;           // persistent session page — kept alive for all API calls
        this._sessionValid = false;
        this._csrfToken = null;

        if (accountPair) {
            this._liAt = accountPair.liAt;
            this._jsessionId = accountPair.jsessionId || "";
            this._proxyServer = accountPair.proxyServer || "";
            this._proxyUsername = accountPair.proxyUsername || "";
            this._proxyPassword = accountPair.proxyPassword || "";
            this._label = accountPair.label || "injected";
        } else {
            this._liAt = process.env.LINKEDIN_LI_AT_COOKIE || "";
            this._jsessionId = process.env.LINKEDIN_JSESSIONID?.replace(/"/g, "") || "";
            this._proxyServer = process.env.PROXY_SERVER || "";
            this._proxyUsername = process.env.PROXY_USERNAME || "";
            this._proxyPassword = process.env.PROXY_PASSWORD || "";
            this._label = "legacy-env";
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Initialization & Session Management
    // ═══════════════════════════════════════════════════════════════════

    async initialize() {
        const launchOptions = {
            headless: "new",
            args: [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
        };

        if (this._proxyServer) {
            launchOptions.proxy = {
                server: this._proxyServer,
                username: this._proxyUsername,
                password: this._proxyPassword,
            };
            console.log(`  🔀 [${this._label}] Using proxy: ${this._proxyServer}`);
        }

        this.browser = await chromium.launch(launchOptions);
        this.context = await this.browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            viewport: { width: 1920, height: 1080 },
            locale: "en-US",
        });

        // Inject cookies
        await this._injectCookies();
        console.log(`✅ [${this._label}] LinkedIn client initialized`);
    }

    /**
     * Inject (or re-inject) the li_at + JSESSIONID cookies into the browser context.
     */
    async _injectCookies() {
        if (!this._liAt) return;

        await this.context.clearCookies();

        const cookies = [{
            name: "li_at",
            value: this._liAt.trim().replace(/^["']|["']$/g, ""),
            domain: ".linkedin.com",
            path: "/",
            httpOnly: true,
            secure: true,
        }];

        if (this._jsessionId) {
            cookies.push({
                name: "JSESSIONID",
                value: `"${this._jsessionId}"`,
                domain: ".linkedin.com",
                path: "/",
                httpOnly: false,
                secure: true,
            });
        }

        await this.context.addCookies(cookies);
    }

    /**
     * Ensure we have a live, authenticated session page (this._page).
     * Keeps the page open so all subsequent API calls can reuse it.
     * On login redirect: re-injects cookies and retries a different URL.
     */
    async _ensureSession() {
        // If page is alive and session confirmed, nothing to do
        if (this._sessionValid && this._page && !this._page.isClosed()) return;
        if (!this._liAt) throw new Error("No li_at cookie configured");

        // Clean up stale page
        if (this._page && !this._page.isClosed()) await this._page.close().catch(() => { });
        this._page = null;
        this._sessionValid = false;

        for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
            const entryUrl = SESSION_ENTRY_URLS[(attempt - 1) % SESSION_ENTRY_URLS.length];

            if (attempt > 1) {
                console.log(`  🔄 [${this._label}] Session retry ${attempt}/${MAX_SESSION_RETRIES} via ${entryUrl.split(".com")[1]}...`);
                await this._injectCookies();
                await this._sleep(1000 + Math.random() * 1000);
            }

            const page = await this.context.newPage();
            try {
                await page.goto(entryUrl, {
                    waitUntil: "domcontentloaded",
                    timeout: NAV_TIMEOUT,
                }).catch(() => { });

                // Wait for any JS-based redirects (LinkedIn SPA)
                await page.waitForTimeout(2000);

                const url = page.url();

                if (
                    url.includes("/login") ||
                    url.includes("/authwall") ||
                    url.includes("/checkpoint") ||
                    url === "about:blank" ||
                    url.startsWith("chrome-error://")
                ) {
                    const reason = url.startsWith("chrome-error://")
                        ? "proxy cannot connect to LinkedIn (chrome-error)"
                        : `auth redirect → ${url.split("?")[0]}`;
                    console.log(`  ⚠️ [${this._label}] Session failed: ${reason} (attempt ${attempt})`);
                    await page.close().catch(() => { });
                    continue;
                }

                // Keep this page open — it's our session page for API calls
                this._page = page;
                this._sessionValid = true;
                await this._refreshCsrfToken();
                console.log(`  ✅ [${this._label}] Session established: ${url.substring(0, 70)}`);
                return;
            } catch (err) {
                console.log(`  ⚠️ [${this._label}] Session attempt ${attempt} error: ${err.message.substring(0, 100)}`);
                await page.close().catch(() => { });
            }
        }

        throw new Error(`Session establishment failed after ${MAX_SESSION_RETRIES} attempts`);
    }

    /**
     * Grab or refresh the CSRF token from cookies.
     */
    async _refreshCsrfToken() {
        if (this._jsessionId) {
            this._csrfToken = this._jsessionId.replace(/^"|"$/g, "");
            return;
        }
        const cookies = await this.context.cookies("https://www.linkedin.com");
        const jsession = cookies.find(c => c.name === "JSESSIONID");
        if (jsession) {
            this._csrfToken = jsession.value.replace(/"/g, "");
        }
    }

    /**
     * Make a Voyager API GET using Chrome's native fetch via page.evaluate().
     *
     * CRITICAL: This uses Chrome's real HTTP/TLS stack (correct JA3 fingerprint).
     * context.request.get() has a different TLS fingerprint and LinkedIn times it out.
     */
    async _apiGet(url, retryOnFail = true) {
        await this._ensureSession();

        const csrfToken = this._csrfToken || this._jsessionId?.replace(/^"|"$/g, "") || "";
        const headers = {
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "accept-language": "en-US,en;q=0.9",
            "csrf-token": csrfToken,
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
            "x-li-page-instance": "urn:li:page:d_flagship3_profile_view_base",
            "x-li-track": JSON.stringify({ clientVersion: "1.13.15427", mpVersion: "1.13.15427", osName: "web", timezoneOffset: -5, timezone: "America/Chicago", mpName: "voyager-web" }),
        };

        try {
            const result = await this._page.evaluate(
                async ({ fetchUrl, fetchHeaders, timeout }) => {
                    try {
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), timeout);
                        const res = await fetch(fetchUrl, {
                            method: "GET",
                            headers: fetchHeaders,
                            credentials: "include",
                            signal: ctrl.signal,
                        });
                        clearTimeout(timer);
                        let data;
                        try { data = await res.json(); } catch { data = await res.text(); }
                        return { ok: res.ok, status: res.status, data };
                    } catch (e) {
                        return { ok: false, status: 0, error: e.message };
                    }
                },
                { fetchUrl: url, fetchHeaders: headers, timeout: FETCH_TIMEOUT }
            );

            if ((result.status === 401 || result.status === 403) && retryOnFail) {
                console.log(`  ⚠️ [${this._label}] API ${result.status} — re-establishing session...`);
                this._sessionValid = false;
                await this._ensureSession();
                return this._apiGet(url, false);
            }

            return result;
        } catch (err) {
            // Session page crashed — rebuild it
            if (err.message.includes("closed") || err.message.includes("Target")) {
                this._sessionValid = false;
                this._page = null;
                if (retryOnFail) {
                    console.log(`  ⚠️ [${this._label}] Session page died, re-establishing...`);
                    await this._ensureSession();
                    return this._apiGet(url, false);
                }
            }
            return { ok: false, status: 0, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MAIN ENTRY: fetchCreatorPosts — layered fallback
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorPosts(profileUrl, maxPosts = 25) {
        if (!this.browser) throw new Error("LinkedInClient not initialized.");

        const profileSlug = this._extractProfileSlug(profileUrl);
        if (!profileSlug) throw new Error(`Could not extract slug from: ${profileUrl}`);

        // Track whether any layer made a successful authenticated call (vs all erroring out)
        let anyLayerReachedAPI = false;
        const layerErrors = [];

        // ── Layer 1: GraphQL API (fastest, most data) ──
        try {
            await this._ensureSession();
            anyLayerReachedAPI = true;
            const apiPosts = await this._fetchPostsViaAPI(profileSlug, maxPosts);
            if (apiPosts.length > 0) return apiPosts;
            console.log(`  ⚠️ [${this._label}] GraphQL API returned 0 posts, trying REST API...`);
        } catch (err) {
            layerErrors.push(`GraphQL: ${err.message.substring(0, 100)}`);
            console.log(`  ⚠️ [${this._label}] GraphQL API failed: ${err.message.substring(0, 100)}`);
        }

        // ── Layer 2: REST Activity API (different endpoint, still fast) ──
        try {
            if (!this._sessionValid) {
                await this._ensureSession();
                anyLayerReachedAPI = true;
            }
            const restPosts = await this._fetchPostsViaActivityAPI(profileSlug, maxPosts);
            if (restPosts.length > 0) return restPosts;
            console.log(`  ⚠️ [${this._label}] REST Activity API returned 0 posts, falling back to DOM...`);
        } catch (err) {
            layerErrors.push(`REST: ${err.message.substring(0, 100)}`);
            console.log(`  ⚠️ [${this._label}] REST Activity API failed: ${err.message.substring(0, 100)}`);
        }

        // ── Layer 3: DOM scroll (slowest, last resort) ──
        try {
            if (!this._sessionValid) {
                await this._ensureSession();
                anyLayerReachedAPI = true;
            }
            const domPosts = await this._fetchPostsViaDOM(profileUrl, maxPosts);
            if (domPosts.length > 0) return domPosts;
        } catch (err) {
            layerErrors.push(`DOM: ${err.message.substring(0, 100)}`);
            console.log(`  ❌ [${this._label}] DOM fallback also failed: ${err.message.substring(0, 100)}`);
            // Re-throw browser crashes for pool recovery
            if (err.message.includes("has been closed") || err.message.includes("Target closed")) {
                throw err;
            }
        }

        // If no layer could even establish a session, this is a hard failure (proxy/cookie issue)
        // Throw so the pool rotates to the next account
        if (!anyLayerReachedAPI || layerErrors.length === 3) {
            throw new Error(`All ${layerErrors.length} scraping layers failed for ${profileSlug}: ${layerErrors.join(" | ")}`);
        }

        // At least one layer reached the API but found 0 posts — might be a legit empty profile
        console.log(`  ℹ️ [${this._label}] All layers returned 0 posts for ${profileSlug} (not an error)`);
        return [];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  LAYER 1: GraphQL API (voyagerFeedDashProfileUpdates)
    // ═══════════════════════════════════════════════════════════════════

    async _fetchPostsViaAPI(profileSlug, maxPosts) {
        // Step 1: Resolve profile URN
        const profileUrn = await this._resolveProfileUrn(profileSlug);
        if (!profileUrn) throw new Error(`Could not resolve profile URN for ${profileSlug}`);
        console.log(`  ✅ [${this._label}] Profile URN: ${profileUrn}`);

        // Step 2: Paginate through GraphQL feed
        console.log(`  📡 [${this._label}] Fetching posts via GraphQL (target: ${maxPosts})...`);
        const allPosts = [];
        const seenUrns = new Set();
        let start = 0;
        let paginationToken = null;
        const count = 20;
        let pageNum = 0;
        const maxPages = Math.min(Math.ceil(maxPosts / count) + 5, 15);
        let consecutiveEmpty = 0;

        while (allPosts.length < maxPosts && pageNum < maxPages) {
            pageNum++;

            let variables;
            if (pageNum === 1 || !paginationToken) {
                variables = `(count:${count},start:${start},profileUrn:${encodeURIComponent(profileUrn)})`;
            } else {
                variables = `(count:${count},start:${start},paginationToken:${encodeURIComponent(paginationToken)},profileUrn:${encodeURIComponent(profileUrn)})`;
            }

            const feedUrl =
                `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true` +
                `&variables=${variables}` +
                `&queryId=voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822`;

            const feedResp = await this._apiGet(feedUrl);

            if (!feedResp.ok) {
                console.log(`  ⚠️ [${this._label}] GraphQL page ${pageNum} failed (${feedResp.status}): ${String(feedResp.data || feedResp.error).substring(0, 150)}`);
                break;
            }

            const feedData = feedResp.data;
            if (!feedData) break;

            // Pagination token for next page
            const feedMeta = feedData?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.metadata;
            if (feedMeta?.paginationToken) paginationToken = feedMeta.paginationToken;

            const posts = this._parseGraphQLPosts(feedData, profileSlug);

            let newCount = 0;
            for (const p of posts) {
                if (!seenUrns.has(p.urn)) {
                    seenUrns.add(p.urn);
                    allPosts.push(p);
                    newCount++;
                }
            }

            // Check if truly empty
            const rawUpdateCount = (feedData?.included || []).filter(
                i => i.$type === "com.linkedin.voyager.dash.feed.Update"
            ).length;
            if (rawUpdateCount === 0) break;

            if (newCount === 0) {
                if (++consecutiveEmpty >= 3) break;
            } else {
                consecutiveEmpty = 0;
            }

            start += count;

            // Human-like heavy rate limit
            await this._sleep(2000 + Math.random() * 3000);

            // Check total
            const paging = feedData?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.paging || feedData?.data?.paging;
            if (paging?.total !== undefined && paging.total > 0 && start >= paging.total) break;
        }

        const deduped = this._deduplicatePosts(allPosts);
        deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
        console.log(`  ✅ [${this._label}] ${deduped.length} posts via GraphQL (${pageNum} pages)`);
        return deduped.slice(0, maxPosts);
    }

    /**
     * Resolve a profile slug to a URN. Retries up to 3 times with session re-establishment.
     */
    async _resolveProfileUrn(profileSlug) {
        console.log(`  🔍 [${this._label}] Resolving profile URN for "${profileSlug}"...`);

        for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) {
                console.log(`  🔄 [${this._label}] URN resolution retry ${attempt}/3...`);
                this._sessionValid = false;
                await this._ensureSession();
                await this._sleep(1000);
            }

            const resp = await this._apiGet(
                `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`,
                attempt < 3 // retry internally except on last attempt
            );

            if (resp.ok && resp.data) {
                // Priority 1: *elements
                const elements = resp.data?.data?.["*elements"];
                if (Array.isArray(elements) && elements.length > 0) return elements[0];

                // Priority 2: included array
                const included = resp.data?.included || [];
                const entity = included.find(i =>
                    i.$type === "com.linkedin.voyager.dash.identity.profile.Profile" &&
                    i.entityUrn && i.publicIdentifier === profileSlug
                );
                if (entity) return entity.entityUrn;
            } else if (resp.status === 0 || resp.error) {
                console.log(`  ⚠️ [${this._label}] URN request failed: ${(resp.error || "unknown").substring(0, 100)}`);
            } else {
                console.log(`  ⚠️ [${this._label}] URN API returned ${resp.status}`);
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  LAYER 2: REST Activity API (alternate Voyager endpoint)
    // ═══════════════════════════════════════════════════════════════════

    async _fetchPostsViaActivityAPI(profileSlug, maxPosts) {
        console.log(`  📡 [${this._label}] Trying REST activity feed for "${profileSlug}"...`);

        // This endpoint doesn't need a URN, uses vanity name directly
        const url =
            `https://www.linkedin.com/voyager/api/feed/dash/profiles/updates` +
            `?profileUrn=urn:li:fsd_profile:${profileSlug}` +
            `&q=memberShareFeed&moduleKey=member-shares:phone&count=${Math.min(maxPosts, 50)}` +
            `&start=0`;

        const resp = await this._apiGet(url);

        if (!resp.ok || !resp.data) {
            // Try the older-format endpoint
            const altUrl =
                `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2` +
                `?profileId=${profileSlug}&q=memberShareFeed&moduleKey=member-shares:phone` +
                `&count=${Math.min(maxPosts, 50)}&start=0`;
            const altResp = await this._apiGet(altUrl);

            if (!altResp.ok || !altResp.data) {
                throw new Error(`REST activity API failed (${resp.status}, alt ${altResp.status})`);
            }

            return this._parseGraphQLPosts(altResp.data, profileSlug);
        }

        return this._parseGraphQLPosts(resp.data, profileSlug);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  LAYER 3: DOM Scroll Fallback
    // ═══════════════════════════════════════════════════════════════════

    async _fetchPostsViaDOM(profileUrl, maxPosts) {
        const profileSlug = this._extractProfileSlug(profileUrl);
        const page = await this.context.newPage();

        try {
            // Try direct profile URL first, then recent-activity
            const urls = [
                `https://www.linkedin.com/in/${profileSlug}/recent-activity/all/`,
                `https://www.linkedin.com/in/${profileSlug}/`,
            ];

            let pageLoaded = false;
            for (const url of urls) {
                try {
                    console.log(`  🌐 [${this._label}] DOM: navigating to ${url.split(".com")[1]}`);
                    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
                    await page.waitForTimeout(1500);

                    const currentUrl = page.url();
                    const isAuthWall = currentUrl.includes("/login") || currentUrl.includes("/authwall") || currentUrl === "about:blank";
                    if (isAuthWall) {
                        console.log(`  ⚠️ [${this._label}] DOM: redirected to login, re-injecting cookies...`);
                        await this._injectCookies();
                        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
                        await page.waitForTimeout(1500);

                        const retryUrl = page.url();
                        if (retryUrl.includes("/login") || retryUrl.includes("/authwall") || retryUrl === "about:blank") {
                            continue; // try next URL
                        }
                    }

                    pageLoaded = true;
                    break;
                } catch (e) {
                    console.log(`  ⚠️ [${this._label}] DOM nav failed: ${e.message.substring(0, 80)}`);
                }
            }

            if (!pageLoaded) {
                console.log(`  ❌ [${this._label}] Could not load any profile page for DOM scraping`);
                return [];
            }

            await this._expandPosts(page);
            await this._scrollForPosts(page, maxPosts);
            await this._expandPosts(page);

            const posts = await this._parsePostsFromDOM(page);
            console.log(`  📊 [${this._label}] DOM parsed: ${posts.length} posts`);

            const deduped = this._deduplicatePosts(posts);
            deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
            return deduped.slice(0, maxPosts);
        } catch (error) {
            if (error.message.includes("has been closed") || error.message.includes("Target closed")) throw error;
            console.error(`  ❌ [${this._label}] DOM error:`, error.message);
            return [];
        } finally {
            await page.close().catch(() => { });
        }
    }

    async _scrollForPosts(page, targetCount) {
        let scrollAttempts = 0;
        const maxScrolls = Math.min(Math.ceil(targetCount / 3) + 10, 200);
        let lastHeight = 0;
        let staleScrolls = 0;

        while (scrollAttempts < maxScrolls) {
            try {
                // Human-like progressive scrolling
                await page.evaluate(async () => {
                    const scrolls = Math.floor(Math.random() * 4) + 3; // 3 to 6 steps
                    for (let i = 0; i < scrolls; i++) {
                        window.scrollBy(0, Math.random() * 300 + 100);
                        await new Promise(r => setTimeout(r, Math.random() * 400 + 100));
                    }
                });
                const delay = SCROLL_DELAY_MIN + Math.random() * (SCROLL_DELAY_MAX - SCROLL_DELAY_MIN);
                await page.waitForTimeout(delay);

                try {
                    const showMore = await page.$('button.scaffold-finite-scroll__load-button');
                    if (showMore) { await showMore.click(); await page.waitForTimeout(1500); }
                } catch { }

                const newHeight = await page.evaluate(() => document.body.scrollHeight);
                if (newHeight === lastHeight) {
                    if (++staleScrolls >= 5) break;
                } else {
                    staleScrolls = 0;
                    lastHeight = newHeight;
                }
                scrollAttempts++;
            } catch { break; }
        }
    }

    async _expandPosts(page) {
        try {
            const buttons = await page.$$('button.feed-shared-inline-show-more-text__button, button[aria-label*="see more"], span.feed-shared-inline-show-more-text__see-more-less-toggle');
            for (const btn of buttons.slice(0, 30)) {
                try {
                    await btn.hover();
                    await page.waitForTimeout(Math.random() * 300 + 200);
                    await btn.click();
                    await page.waitForTimeout(Math.random() * 800 + 400);
                } catch { }
            }
        } catch { }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Profile Fetching
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorProfile(profileUrl) {
        if (!this.browser) throw new Error("LinkedInClient not initialized.");

        const profileSlug = this._extractProfileSlug(profileUrl);

        try {
            if (!this._sessionValid) await this._ensureSession();

            const resp = await this._apiGet(
                `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`
            );

            if (!resp.ok || !resp.data) {
                return { name: profileSlug, bio: "", image: "", followersCount: 0 };
            }

            const included = resp.data?.included || [];
            const profile = included.find(i =>
                i.$type === "com.linkedin.voyager.dash.identity.profile.Profile" &&
                i.publicIdentifier === profileSlug
            );

            if (!profile) return { name: profileSlug, bio: "", image: "", followersCount: 0 };

            // Extract follower count from NetworkInfo
            let followersCount = 0;
            const networkInfo = included.find(i =>
                i.$type?.includes("NetworkInfo") || i.followersCount !== undefined
            );
            if (networkInfo) followersCount = networkInfo.followersCount || 0;

            return {
                name: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
                bio: profile.headline || "",
                image: profile.profilePicture?.displayImageReference?.vectorImage?.artifacts?.[0]?.fileIdentifyingUrlPathSegment || "",
                followersCount,
            };
        } catch (error) {
            console.log(`  ⚠️ [${this._label}] Profile fetch error: ${error.message.substring(0, 80)}`);
            return { name: profileSlug || "", bio: "", image: "", followersCount: 0 };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  GraphQL Response Parsing
    // ═══════════════════════════════════════════════════════════════════

    _parseGraphQLPosts(feedData, profileSlug) {
        const posts = [];
        try {
            const included = feedData?.included || [];

            // Build engagement counts lookup
            const countsMap = {};
            for (const item of included) {
                if (item.$type === "com.linkedin.voyager.dash.feed.SocialActivityCounts") {
                    const activityUrn = item.urn || item.entityUrn?.replace("urn:li:fsd_socialActivityCounts:", "") || "";
                    countsMap[activityUrn] = item;
                }
            }

            const updates = included.filter(i => i.$type === "com.linkedin.voyager.dash.feed.Update");

            for (const item of updates) {
                try {
                    const commentary = item.commentary?.text?.text;
                    if (!commentary || commentary.length < 5) continue;
                    if (item.resharedUpdate && (!commentary || commentary.length < 50)) continue;

                    let activityUrn = "";
                    const activityMatch = item.entityUrn?.match(/urn:li:activity:(\d+)/);
                    if (activityMatch) activityUrn = `urn:li:activity:${activityMatch[1]}`;

                    const counts = countsMap[activityUrn] || {};

                    let postedAt = null;
                    if (activityMatch) {
                        const ts = Number(BigInt(activityMatch[1]) >> 22n);
                        if (ts > 1000000000000) postedAt = new Date(ts).toISOString();
                    }
                    if (!postedAt && item.metadata?.backendUrn) {
                        const m = item.metadata.backendUrn.match(/(\d+)$/);
                        if (m) {
                            const ts = Number(BigInt(m[1]) >> 22n);
                            if (ts > 1000000000000) postedAt = new Date(ts).toISOString();
                        }
                    }

                    let postType = "text";
                    const content = item.content;
                    if (content) {
                        if (content.videoComponent || content["com.linkedin.voyager.feed.render.LinkedInVideoComponent"]) postType = "video";
                        else if (content.documentComponent || content["com.linkedin.voyager.feed.render.DocumentComponent"]) postType = "carousel";
                        else if (content.imageComponent || content["com.linkedin.voyager.feed.render.ImageComponent"]) postType = "image";
                        else if (content.articleComponent || content["com.linkedin.voyager.feed.render.ArticleComponent"]) postType = "article";
                        else if (content.carouselContent || item.carouselContent) postType = "carousel";
                    }

                    posts.push({
                        urn: item.entityUrn || activityUrn || `gql_${Date.now()}_${posts.length}`,
                        text: commentary,
                        totalReactions: counts.numLikes || 0,
                        commentCount: counts.numComments || 0,
                        repostCount: counts.numShares || 0,
                        postedAt,
                        authorName: item.actor?.name?.text || profileSlug,
                        type: postType,
                        media: null,
                    });
                } catch { continue; }
            }
        } catch (err) {
            console.log(`  ⚠️ GraphQL parse error: ${err.message}`);
        }
        return posts;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DOM Parsing
    // ═══════════════════════════════════════════════════════════════════

    async _parsePostsFromDOM(page) {
        return await page.evaluate(() => {
            const posts = [];

            const containers = document.querySelectorAll(
                '.feed-shared-update-v2, [data-urn*="activity"], .profile-creator-shared-feed-update__container, .occludable-update'
            );

            for (const container of containers) {
                try {
                    const textEl = container.querySelector(
                        '.feed-shared-text .break-words, .feed-shared-update-v2__commentary .break-words, .update-components-text .break-words, span[dir="ltr"].break-words'
                    );
                    const text = textEl?.innerText?.trim() || '';
                    if (!text || text.length < 20) continue;

                    const headerText = container.querySelector('.feed-shared-actor__sub-description, .update-components-header__text-view')?.textContent || '';
                    if (headerText.includes('reposted') || headerText.includes('shared')) continue;

                    const urn = container.getAttribute('data-urn') || container.querySelector('[data-urn]')?.getAttribute('data-urn') || `dom_${Date.now()}_${posts.length}`;

                    let reactions = 0, commentCount = 0, repostCount = 0;
                    const reactionsEl = container.querySelector('.social-details-social-counts__reactions-count, span.social-details-social-counts__reactions-count');
                    if (reactionsEl) reactions = _parseCompact(reactionsEl.textContent);
                    const commentsEl = container.querySelector('button[aria-label*="comment"] span, .social-details-social-counts__comments');
                    if (commentsEl) commentCount = _parseCompact(commentsEl.textContent);
                    const repostsEl = container.querySelector('button[aria-label*="repost"] span');
                    if (repostsEl) repostCount = _parseCompact(repostsEl.textContent);

                    let postedAt = null;
                    const timeEl = container.querySelector('time');
                    if (timeEl) postedAt = timeEl.getAttribute('datetime') || null;

                    if (!postedAt) {
                        const timeTextEl = container.querySelector(
                            '.update-components-actor__sub-description span[aria-hidden="true"], .feed-shared-actor__sub-description span[aria-hidden="true"], .update-components-actor__sub-description, .feed-shared-actor__sub-description'
                        );
                        if (timeTextEl) {
                            const timeStr = timeTextEl.textContent.trim().split('•')[0].trim();
                            const match = timeStr.match(/(\d+)\s*(mo|yr|m|h|d|w|y)/i);
                            if (match) {
                                const num = parseInt(match[1]);
                                const unit = match[2].toLowerCase();
                                const now = new Date();
                                if (unit === 'm') now.setMinutes(now.getMinutes() - num);
                                else if (unit === 'h') now.setHours(now.getHours() - num);
                                else if (unit === 'd') now.setDate(now.getDate() - num);
                                else if (unit === 'w') now.setDate(now.getDate() - num * 7);
                                else if (unit === 'mo') now.setMonth(now.getMonth() - num);
                                else if (unit === 'yr' || unit === 'y') now.setFullYear(now.getFullYear() - num);
                                postedAt = now.toISOString();
                            }
                        }
                    }

                    let authorName = '';
                    const authorEl = container.querySelector('.feed-shared-actor__name span, .update-components-actor__name span');
                    if (authorEl) authorName = authorEl.textContent?.trim() || '';

                    const media = [];
                    const images = container.querySelectorAll('.feed-shared-image__image, .feed-shared-image img, .update-components-image img, .feed-shared-carousel img, .ivm-image-view-model img');
                    for (const img of images) {
                        const src = img.getAttribute('src') || img.getAttribute('data-delayed-url') || '';
                        if (src && !src.includes('profile-displayphoto') && !src.includes('aero-v1') && src.startsWith('http')) {
                            media.push({ type: 'image', url: src, alt: img.getAttribute('alt') || '' });
                        }
                    }
                    const videoEls = container.querySelectorAll('video, .feed-shared-linkedin-video, .update-components-linkedin-video');
                    for (const vid of videoEls) {
                        const poster = vid.getAttribute('poster') || '';
                        const src = vid.querySelector('source')?.getAttribute('src') || '';
                        media.push({ type: 'video', url: src || poster, poster });
                    }
                    const docEls = container.querySelectorAll('.feed-shared-document, .update-components-document, .ssplayer-card');
                    for (const doc of docEls) {
                        const title = doc.querySelector('.feed-shared-document__title, .ssplayer-card__title')?.textContent?.trim() || '';
                        const pageImgs = doc.querySelectorAll('img');
                        const pages = [];
                        for (const pImg of pageImgs) {
                            const pSrc = pImg.getAttribute('src') || '';
                            if (pSrc && pSrc.startsWith('http')) pages.push(pSrc);
                        }
                        media.push({ type: 'document', title, pageCount: pages.length, pages: pages.slice(0, 20) });
                    }
                    const articleEls = container.querySelectorAll('.feed-shared-article, .update-components-article');
                    for (const art of articleEls) {
                        const link = art.querySelector('a')?.getAttribute('href') || '';
                        const title = art.querySelector('.feed-shared-article__title, .update-components-article__title')?.textContent?.trim() || '';
                        const thumbnail = art.querySelector('img')?.getAttribute('src') || '';
                        if (link || title) media.push({ type: 'article', url: link, title, thumbnail });
                    }

                    let postType = 'text';
                    if (media.some(m => m.type === 'video')) postType = 'video';
                    else if (media.some(m => m.type === 'document')) postType = 'carousel';
                    else if (media.filter(m => m.type === 'image').length > 1) postType = 'carousel';
                    else if (media.some(m => m.type === 'image')) postType = 'image';
                    else if (media.some(m => m.type === 'article')) postType = 'article';

                    posts.push({
                        urn, text, totalReactions: reactions, commentCount, repostCount,
                        postedAt, authorName, type: postType,
                        media: media.length > 0 ? media : null,
                    });
                } catch { continue; }
            }

            function _parseCompact(str) {
                if (!str) return 0;
                const match = str.match(/([\d,]+(?:\.\d+)?)\s*([KMkm])?(?:\s|$|[^a-zA-Z])/);
                if (!match) {
                    const numMatch = str.match(/([\d,]+)/);
                    return numMatch ? parseInt(numMatch[1].replace(/,/g, ''), 10) : 0;
                }
                const num = parseFloat(match[1].replace(/,/g, ''));
                const suffix = (match[2] || '').toUpperCase();
                if (suffix === 'K') return Math.round(num * 1000);
                if (suffix === 'M') return Math.round(num * 1000000);
                return Math.round(num);
            }

            return posts;
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Utilities
    // ═══════════════════════════════════════════════════════════════════

    _extractProfileSlug(profileUrl) {
        if (!profileUrl) return null;
        if (!profileUrl.includes("/") && !profileUrl.includes(".")) return profileUrl;
        const match = profileUrl.match(/linkedin\.com\/in\/([^\/\?]+)/i);
        if (match) return match[1];
        const parts = profileUrl.replace(/\/$/, "").split("/");
        return parts[parts.length - 1];
    }

    _buildActivityUrl(profileUrl) {
        let url = profileUrl.replace(/\/$/, "");
        if (!url.includes("/recent-activity")) url += "/recent-activity/shares/";
        if (!url.startsWith("http")) url = "https://www.linkedin.com/in/" + url;
        return url;
    }

    _deduplicatePosts(posts) {
        const seen = new Set();
        return posts.filter((post) => {
            const key = post.urn || post.text?.slice(0, 100);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async cleanup() {
        if (this._page && !this._page.isClosed()) {
            await this._page.close().catch(() => { });
        }
        this._page = null;
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
            this.context = null;
        }
        this._sessionValid = false;
        this._csrfToken = null;
    }
}
