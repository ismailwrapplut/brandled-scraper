/**
 * LinkedIn Client (Hybrid: Direct Voyager API + Playwright fallback)
 * 
 * PRIMARY: Uses LinkedIn's internal Voyager API with cursor-based pagination.
 *   - Much faster (seconds instead of minutes)
 *   - Can fetch thousands of posts with proper timestamps
 *   - Requires li_at cookie + JSESSIONID
 * 
 * FALLBACK: Scroll-based DOM parsing if API approach fails.
 * 
 * Cost: $0
 */

import { chromium } from "playwright";

const SCROLL_DELAY_MIN = 2500;
const SCROLL_DELAY_MAX = 4500;
const PAGE_LOAD_TIMEOUT = 45000;

export class LinkedInClient {
    constructor() {
        this.browser = null;
        this.context = null;
    }

    async initialize() {
        const launchOptions = {
            headless: true,
            args: [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
            ],
        };

        // Add proxy if configured
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

        const liAt = process.env.LINKEDIN_LI_AT_COOKIE;
        const jsession = process.env.LINKEDIN_JSESSIONID?.replace(/"/g, "");

        if (liAt) {
            const cookiesToAdd = [{
                name: "li_at",
                value: liAt.trim().replace(/^["']|["']$/g, ""),
                domain: ".linkedin.com",
                path: "/",
                httpOnly: true,
                secure: true,
            }];

            if (jsession) {
                cookiesToAdd.push({
                    name: "JSESSIONID",
                    value: `"${jsession}"`, // must have quotes internally
                    domain: ".linkedin.com",
                    path: "/",
                    httpOnly: false,
                    secure: true,
                });
            }

            await this.context.addCookies(cookiesToAdd);
            console.log("✅ LinkedIn client initialized (authenticated)");
        } else {
            console.log("⚠️  No li_at cookie — LinkedIn scraping will not work");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MAIN: fetchCreatorPosts — tries API first, falls back to DOM
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorPosts(profileUrl, maxPosts = 25) {
        if (!this.browser) throw new Error("LinkedInClient not initialized.");

        // Try API first, fall back to DOM
        try {
            const apiPosts = await this._fetchPostsViaAPI(profileUrl, maxPosts);
            if (apiPosts.length > 0) {
                return apiPosts;
            }
            console.log(`  ⚠️ LinkedIn API returned 0 posts, falling back to DOM...`);
        } catch (apiErr) {
            console.log(`  ⚠️ LinkedIn API failed (${apiErr.message}), falling back to DOM...`);
        }

        // Fallback to scroll-based DOM approach
        return this._fetchPostsViaDOM(profileUrl, maxPosts);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PRIMARY: LinkedIn GraphQL API (voyagerFeedDashProfileUpdates)
    // ═══════════════════════════════════════════════════════════════════

    async _fetchPostsViaAPI(profileUrl, maxPosts) {
        const liAt = process.env.LINKEDIN_LI_AT_COOKIE;
        const jsessionId = process.env.LINKEDIN_JSESSIONID?.replace(/"/g, "");

        if (!liAt) throw new Error("No li_at cookie configured");

        const profileSlug = this._extractProfileSlug(profileUrl);
        if (!profileSlug) throw new Error(`Could not extract profile slug from: ${profileUrl}`);

        let csrfToken = jsessionId;
        const page = await this.context.newPage();

        try {
            // Navigate to /feed/ to establish session context.
            // Direct profile URL navigation causes redirect loops on cloud IPs — /feed/ is reliable.
            console.log(`  🌐 LinkedIn: Establishing session via /feed/...`);
            try {
                await page.goto("https://www.linkedin.com/feed/", {
                    waitUntil: "domcontentloaded",
                    timeout: PAGE_LOAD_TIMEOUT,
                });
            } catch { /* page may still be usable */ }

            // Check if redirected to login
            const currentUrl = page.url();
            if (currentUrl.includes("/login") || currentUrl.includes("/authwall") || currentUrl === "about:blank") {
                throw new Error("Redirected to login — li_at cookie invalid/expired");
            }
            console.log(`  ✅ Session established at: ${currentUrl.substring(0, 60)}`);

            if (!csrfToken) {
                const cookies = await this.context.cookies("https://www.linkedin.com");
                csrfToken = cookies.find(c => c.name === "JSESSIONID")?.value?.replace(/"/g, "");
                if (!csrfToken) throw new Error("Could not obtain JSESSIONID for CSRF");
            }

            const headers = {
                "Csrf-Token": csrfToken,
                "X-Restli-Protocol-Version": "2.0.0",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "application/vnd.linkedin.normalized+json+2.1",
                "X-Li-Lang": "en_US",
                "X-Li-Page-Instance": "urn:li:page:d_flagship3_profile_view_base",
            };

            const executeFetch = async (url) => {
                return await page.evaluate(async ({ fetchUrl, fetchHeaders }) => {
                    try {
                        const res = await fetch(fetchUrl, { headers: fetchHeaders, method: "GET" });
                        return {
                            ok: res.ok,
                            status: res.status,
                            data: res.ok ? await res.json() : await res.text(),
                        };
                    } catch (err) {
                        return { ok: false, error: err.message };
                    }
                }, { fetchUrl: url, fetchHeaders: headers });
            };

            // Step 1: Resolve the profile URN (with retry)
            console.log(`  🔍 LinkedIn: Resolving profile URN for "${profileSlug}"...`);
            let profileUrn = null;

            for (let attempt = 1; attempt <= 2 && !profileUrn; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`  🔄 Retrying profile resolution (attempt ${attempt})...`);
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    const profileResp = await executeFetch(
                        `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`
                    );

                    if (profileResp.ok && profileResp.data) {
                        // Priority 1: *elements — always contains the target profile URN (most reliable)
                        const elements = profileResp.data?.data?.["*elements"];
                        if (Array.isArray(elements) && elements.length > 0) {
                            profileUrn = elements[0];
                        }

                        // Priority 2: Match by publicIdentifier in included array
                        if (!profileUrn) {
                            const included = profileResp.data?.included || [];
                            const profileEntity = included.find(i =>
                                i.$type === "com.linkedin.voyager.dash.identity.profile.Profile" &&
                                i.entityUrn &&
                                i.publicIdentifier === profileSlug
                            );
                            if (profileEntity) {
                                profileUrn = profileEntity.entityUrn;
                            }
                        }
                    } else {
                        console.log(`  ⚠️ Profile API returned ${profileResp.status}: ${String(profileResp.data || profileResp.error).substring(0, 150)}`);
                    }
                } catch (e) {
                    console.log(`  ⚠️ Profile resolution attempt ${attempt} failed: ${e.message}`);
                }
            }

            if (!profileUrn) {
                throw new Error(`Could not resolve profile URN for ${profileSlug}`);
            }
            console.log(`  ✅ Profile URN: ${profileUrn}`);

            // Step 2: Fetch posts via GraphQL feed endpoint
            console.log(`  📡 LinkedIn: Fetching posts via GraphQL API (target: ${maxPosts})...`);
            const allPosts = [];
            const seenUrns = new Set();
            let start = 0;
            let paginationToken = null;
            const count = 20; // LinkedIn GraphQL returns 20 per page
            let pageNum = 0;
            const maxPages = Math.min(Math.ceil(maxPosts / count) + 5, 15); // Hard cap at 15 pages
            let consecutiveEmpty = 0;
            let contextRetried = false;

            while (allPosts.length < maxPosts && pageNum < maxPages) {
                pageNum++;

                // Build variables — use paginationToken for page 2+ (LinkedIn requires it)
                let variables;
                if (pageNum === 1 || !paginationToken) {
                    variables = `(count:${count},start:${start},profileUrn:${encodeURIComponent(profileUrn)})`;
                } else {
                    variables = `(count:${count},start:${start},paginationToken:${encodeURIComponent(paginationToken)},profileUrn:${encodeURIComponent(profileUrn)})`;
                }

                const feedUrl = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true` +
                    `&variables=${variables}` +
                    `&queryId=voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822`;

                let feedResp;
                try {
                    feedResp = await executeFetch(feedUrl);
                } catch (evalErr) {
                    // page.evaluate threw — execution context destroyed (page navigated)
                    if (!contextRetried) {
                        contextRetried = true;
                        console.log(`  🔄 Execution context lost on page ${pageNum}, re-establishing session...`);
                        try {
                            await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
                            await page.waitForTimeout(1000);
                        } catch { /* retry anyway */ }
                        pageNum--; // retry this page
                        continue;
                    }
                    console.log(`  ⚠️ Execution context lost again, stopping pagination.`);
                    break;
                }

                if (!feedResp.ok) {
                    // "Failed to fetch" means the page fetch() failed — possibly context or network issue
                    if (feedResp.error === "Failed to fetch" && !contextRetried) {
                        contextRetried = true;
                        console.log(`  🔄 Fetch failed on page ${pageNum}, re-establishing session...`);
                        try {
                            await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
                            await page.waitForTimeout(1000);
                        } catch { /* retry anyway */ }
                        pageNum--; // retry this page
                        continue;
                    }
                    console.log(`  ⚠️ LinkedIn GraphQL failed (${feedResp.status}): ${String(feedResp.data || feedResp.error).substring(0, 200)}`);
                    break;
                }

                const feedData = feedResp.data;
                if (!feedData) {
                    console.log(`  ⚠️ Failed to parse LinkedIn GraphQL response`);
                    break;
                }

                // Extract paginationToken for next page
                const feedMeta = feedData?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.metadata;
                if (feedMeta?.paginationToken) {
                    paginationToken = feedMeta.paginationToken;
                }

                const posts = this._parseGraphQLPosts(feedData, profileSlug);

                // Deduplicate: stop if we see mostly repeated URNs (LinkedIn recycling content)
                let newCount = 0;
                for (const p of posts) {
                    if (!seenUrns.has(p.urn)) {
                        seenUrns.add(p.urn);
                        allPosts.push(p);
                        newCount++;
                    }
                }

                // Check if the API returned any Update items at all (before our filters)
                const rawUpdateCount = (feedData?.included || []).filter(
                    i => i.$type === "com.linkedin.voyager.dash.feed.Update"
                ).length;

                if (rawUpdateCount === 0) {
                    // API truly returned nothing — end of feed
                    console.log(`  📊 LinkedIn: API returned 0 items (page ${pageNum}), end of feed.`);
                    break;
                }

                if (newCount === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 3) {
                        console.log(`  📊 LinkedIn: No new qualifying posts for ${consecutiveEmpty} pages, stopping.`);
                        break;
                    }
                } else {
                    consecutiveEmpty = 0;
                }

                start += count;

                if (pageNum % 3 === 0) {
                    console.log(`  📡 LinkedIn: ${allPosts.length} unique posts after ${pageNum} API pages...`);
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 300 + Math.random() * 500));

                // Check paging total
                const paging = feedData?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.paging ||
                    feedData?.data?.paging;
                if (paging?.total !== undefined && paging.total > 0 && start >= paging.total) {
                    console.log(`  📊 LinkedIn: Reached end of feed (${paging.total} total).`);
                    break;
                }
            }

            // Dedup and sort
            const deduped = this._deduplicatePosts(allPosts);
            deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));

            console.log(`  ✅ LinkedIn: ${deduped.length} unique posts fetched via GraphQL API (${pageNum} pages)`);
            return deduped.slice(0, maxPosts);

        } catch (error) {
            throw error;
        } finally {
            await page.close().catch(() => { });
        }
    }

    /**
     * Parse posts from LinkedIn's GraphQL API response (current format)
     */
    _parseGraphQLPosts(feedData, profileSlug) {
        const posts = [];
        try {
            const included = feedData?.included || [];

            // Build a lookup map for SocialActivityCounts by activity URN
            const countsMap = {};
            for (const item of included) {
                if (item.$type === "com.linkedin.voyager.dash.feed.SocialActivityCounts") {
                    // entityUrn: "urn:li:fsd_socialActivityCounts:urn:li:activity:XXXX"
                    const activityUrn = item.urn || item.entityUrn?.replace("urn:li:fsd_socialActivityCounts:", "") || "";
                    countsMap[activityUrn] = item;
                }
            }

            // Find all Update items
            const updates = included.filter(i => i.$type === "com.linkedin.voyager.dash.feed.Update");

            for (const item of updates) {
                try {
                    const commentary = item.commentary?.text?.text;
                    if (!commentary || commentary.length < 5) continue;

                    // Skip reshares (but keep if they have meaningful commentary)
                    if (item.resharedUpdate && (!commentary || commentary.length < 50)) continue;

                    // Extract activity URN from entityUrn
                    // Format: "urn:li:fsd_update:(urn:li:activity:XXXX,MEMBER_SHARES,...)"
                    let activityUrn = "";
                    const activityMatch = item.entityUrn?.match(/urn:li:activity:(\d+)/);
                    if (activityMatch) {
                        activityUrn = `urn:li:activity:${activityMatch[1]}`;
                    }

                    // Get engagement from SocialActivityCounts
                    const counts = countsMap[activityUrn] || {};
                    const totalReactions = counts.numLikes || 0;
                    const commentCount = counts.numComments || 0;
                    const repostCount = counts.numShares || 0;

                    // Extract timestamp from activity ID (LinkedIn snowflake format)
                    // Activity IDs encode timestamp: (id >> 22) gives ms since epoch
                    let postedAt = null;
                    if (activityMatch) {
                        const activityId = BigInt(activityMatch[1]);
                        // LinkedIn's epoch offset for activity IDs
                        const timestamp = Number(activityId >> 22n);
                        if (timestamp > 1000000000000) {
                            postedAt = new Date(timestamp).toISOString();
                        }
                    }
                    // Fallback: check metadata
                    if (!postedAt && item.metadata?.backendUrn) {
                        const backendMatch = item.metadata.backendUrn.match(/(\d+)$/);
                        if (backendMatch) {
                            const ts = Number(BigInt(backendMatch[1]) >> 22n);
                            if (ts > 1000000000000) postedAt = new Date(ts).toISOString();
                        }
                    }

                    // Extract author name
                    const authorName = item.actor?.name?.text || profileSlug;

                    // Determine post type from content
                    let postType = "text";
                    const content = item.content;
                    if (content) {
                        if (content.videoComponent || content["com.linkedin.voyager.feed.render.LinkedInVideoComponent"]) {
                            postType = "video";
                        } else if (content.documentComponent || content["com.linkedin.voyager.feed.render.DocumentComponent"]) {
                            postType = "carousel";
                        } else if (content.imageComponent || content["com.linkedin.voyager.feed.render.ImageComponent"]) {
                            postType = "image";
                        } else if (content.articleComponent || content["com.linkedin.voyager.feed.render.ArticleComponent"]) {
                            postType = "article";
                        } else if (content.carouselContent || item.carouselContent) {
                            postType = "carousel";
                        }
                    }

                    posts.push({
                        urn: item.entityUrn || activityUrn || `graphql_${Date.now()}_${posts.length}`,
                        text: commentary,
                        totalReactions,
                        commentCount,
                        repostCount,
                        postedAt,
                        authorName,
                        type: postType,
                        media: null,
                    });
                } catch {
                    continue;
                }
            }
        } catch (err) {
            console.log(`  ⚠️ GraphQL parse error: ${err.message}`);
        }

        return posts;
    }

    /**
     * Extract profile slug from URL (e.g. "whyismail" from "https://linkedin.com/in/whyismail")
     */
    _extractProfileSlug(profileUrl) {
        if (!profileUrl) return null;

        // Handle cases like "whyismail" (already a slug)
        if (!profileUrl.includes("/") && !profileUrl.includes(".")) {
            return profileUrl;
        }

        // Extract from URL like "https://www.linkedin.com/in/whyismail/..."
        const match = profileUrl.match(/linkedin\.com\/in\/([^\/\?]+)/i);
        if (match) return match[1];

        // Just use the last path segment
        const parts = profileUrl.replace(/\/$/, "").split("/");
        return parts[parts.length - 1];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Profile fetching
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorProfile(profileUrl) {
        if (!this.browser) throw new Error("LinkedInClient not initialized.");

        const profileSlug = this._extractProfileSlug(profileUrl);
        const jsessionId = process.env.LINKEDIN_JSESSIONID?.replace(/"/g, "");

        const page = await this.context.newPage();
        try {
            // Navigate via /feed/ to avoid profile-page redirect storms on cloud IPs
            await page.goto("https://www.linkedin.com/feed/", {
                waitUntil: "domcontentloaded",
                timeout: PAGE_LOAD_TIMEOUT,
            }).catch(() => {});

            const csrfToken = jsessionId ||
                (await this.context.cookies("https://www.linkedin.com")).find(c => c.name === "JSESSIONID")?.value?.replace(/"/g, "");

            const profileData = await page.evaluate(async ({ slug, csrf }) => {
                try {
                    const res = await fetch(
                        `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`,
                        {
                            headers: {
                                "Csrf-Token": csrf,
                                "X-Restli-Protocol-Version": "2.0.0",
                                "Accept": "application/vnd.linkedin.normalized+json+2.1",
                            },
                        }
                    );
                    if (!res.ok) return null;
                    const json = await res.json();
                    const included = json?.included || [];
                    const profile = included.find(i =>
                        i.$type === "com.linkedin.voyager.dash.identity.profile.Profile" &&
                        i.publicIdentifier === slug
                    );
                    if (!profile) return null;
                    return {
                        name: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
                        bio: profile.headline || "",
                        image: profile.profilePicture?.displayImageReference?.vectorImage?.artifacts?.[0]?.fileIdentifyingUrlPathSegment || "",
                        followersCount: 0,
                    };
                } catch { return null; }
            }, { slug: profileSlug, csrf: csrfToken });

            if (profileData) return profileData;

            // Fallback: return slug as name
            return { name: profileSlug, bio: "", image: "", followersCount: 0 };
        } catch (error) {
            console.error(`  ❌ Error fetching LinkedIn profile ${profileUrl}:`, error.message);
            return { name: profileSlug || "", bio: "", image: "", followersCount: 0 };
        } finally {
            try { if (!page.isClosed()) await page.close(); } catch { }
        }
    }

    async _fetchProfileViaAPI(profileUrl) {
        const liAt = process.env.LINKEDIN_LI_AT_COOKIE;
        const jsessionId = process.env.LINKEDIN_JSESSIONID?.replace(/"/g, "");
        if (!liAt || !jsessionId) return null;

        const profileSlug = this._extractProfileSlug(profileUrl);
        if (!profileSlug) return null;

        const headers = {
            "Csrf-Token": jsessionId,
            "X-Restli-Protocol-Version": "2.0.0",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "application/vnd.linkedin.normalized+json+2.1",
        };

        const page = await this.context.newPage();
        try {
            await page.goto(`https://www.linkedin.com/in/${profileSlug}/`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
            await page.waitForTimeout(2000);

            const data = await page.evaluate(async ({ profileSlug, headers }) => {
                const res = await fetch(`https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`, { headers });
                if (!res.ok) return null;
                return await res.json();
            }, { profileSlug, headers });

            if (!data) return null;
            const included = data?.included || [];

            let name = "", bio = "", image = "", followersCount = 0;

            for (const item of included) {
                if (item.$type?.includes("Profile") || item.firstName) {
                    name = name || `${item.firstName || ""} ${item.lastName || ""}`.trim();
                    bio = bio || item.headline || item.summary || "";
                    if (item.profilePicture?.displayImageReference?.vectorImage) {
                        const artifacts = item.profilePicture.displayImageReference.vectorImage.artifacts || [];
                        const largest = artifacts[artifacts.length - 1];
                        if (largest) {
                            const rootUrl = item.profilePicture.displayImageReference.vectorImage.rootUrl || "";
                            image = rootUrl + (largest.fileIdentifyingUrlPathSegment || "");
                        }
                    }
                    if (item.picture?.["com.linkedin.common.VectorImage"]) {
                        const pic = item.picture["com.linkedin.common.VectorImage"];
                        const artifacts = pic.artifacts || [];
                        const largest = artifacts[artifacts.length - 1];
                        if (largest) {
                            image = (pic.rootUrl || "") + (largest.fileIdentifyingUrlPathSegment || "");
                        }
                    }
                }
                if (item.$type?.includes("NetworkInfo") || item.followersCount !== undefined) {
                    followersCount = item.followersCount || followersCount;
                }
            }

            if (name) {
                console.log(`  📸 LinkedIn profile via API: name="${name}", followers=${followersCount}`);
                return { name, bio, image, followersCount };
            }

            return null;
        } catch (error) {
            console.error(`  ❌ Error fetching LinkedIn profile API for ${profileUrl}:`, error.message);
            return null;
        } finally {
            await page.close().catch(() => { });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  FALLBACK: Scroll-based DOM parsing
    // ═══════════════════════════════════════════════════════════════════

    async _fetchPostsViaDOM(profileUrl, maxPosts) {
        let page;
        try {
            page = await this.context.newPage();
        } catch (err) {
            throw new Error(`Could not open page: ${err.message}`);
        }

        try {
            const activityUrl = this._buildActivityUrl(profileUrl);
            await page.goto(activityUrl, {
                waitUntil: "domcontentloaded",
                timeout: PAGE_LOAD_TIMEOUT,
            });
            await page.waitForTimeout(4000);

            const currentUrl = page.url();
            if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
                console.log("  ⚠️  Redirected to login — li_at cookie invalid");
                return [];
            }

            await this._expandPosts(page);
            await this._scrollForPosts(page, maxPosts);
            await this._expandPosts(page);

            const posts = await this._parsePostsFromDOM(page);
            console.log(`  📊 LinkedIn DOM parsed: ${posts.length} raw posts`);

            const deduped = this._deduplicatePosts(posts);
            console.log(`  📊 LinkedIn after dedup: ${deduped.length} unique posts (requested max: ${maxPosts})`);
            deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
            return deduped.slice(0, maxPosts);
        } catch (error) {
            // Re-throw with context so the seed job can detect browser crashes
            if (error.message.includes("has been closed") || error.message.includes("Target closed")) {
                throw error; // Let the caller handle browser recovery
            }
            console.error(`  ❌ Error scraping ${profileUrl}:`, error.message);
            return [];
        } finally {
            try { if (page && !page.isClosed()) await page.close(); } catch { }
        }
    }

    async _scrollForPosts(page, targetCount) {
        let scrollAttempts = 0;
        const maxScrolls = Math.min(Math.ceil(targetCount / 3) + 10, 500);
        let lastHeight = 0;
        let staleScrolls = 0;

        while (scrollAttempts < maxScrolls) {
            try {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
                const delay = SCROLL_DELAY_MIN + Math.random() * (SCROLL_DELAY_MAX - SCROLL_DELAY_MIN);
                await page.waitForTimeout(delay);

                try {
                    const showMore = await page.$('button.scaffold-finite-scroll__load-button');
                    if (showMore) { await showMore.click(); await page.waitForTimeout(2000); }
                } catch { }

                const newHeight = await page.evaluate(() => document.body.scrollHeight);
                if (newHeight === lastHeight) {
                    staleScrolls++;
                    if (staleScrolls >= 8) break;
                } else {
                    staleScrolls = 0;
                    lastHeight = newHeight;
                }
                scrollAttempts++;

                if (scrollAttempts % 50 === 0) {
                    const currentPosts = await page.$$eval(
                        'div.feed-shared-update-v2, div[data-urn]',
                        els => els.length
                    ).catch(() => '?');
                    console.log(`  📜 LinkedIn: ~${currentPosts} posts after ${scrollAttempts} scrolls...`);
                }
            } catch { break; }
        }
    }

    async _expandPosts(page) {
        try {
            const buttons = await page.$$('button.feed-shared-inline-show-more-text__button, button[aria-label*="see more"], span.feed-shared-inline-show-more-text__see-more-less-toggle');
            for (const btn of buttons.slice(0, 40)) {
                try { await btn.click(); await page.waitForTimeout(150); } catch { }
            }
        } catch { }
    }

    async _parsePostsFromDOM(page) {
        return await page.evaluate(() => {
            const posts = [];

            const containers = document.querySelectorAll(
                '.feed-shared-update-v2, ' +
                '[data-urn*="activity"], ' +
                '.profile-creator-shared-feed-update__container, ' +
                '.occludable-update'
            );

            for (const container of containers) {
                try {
                    const textEl = container.querySelector(
                        '.feed-shared-text .break-words, ' +
                        '.feed-shared-update-v2__commentary .break-words, ' +
                        '.update-components-text .break-words, ' +
                        'span[dir="ltr"].break-words'
                    );
                    const text = textEl?.innerText?.trim() || '';
                    if (!text || text.length < 20) continue;

                    const headerText = container.querySelector(
                        '.feed-shared-actor__sub-description, ' +
                        '.update-components-header__text-view'
                    )?.textContent || '';
                    if (headerText.includes('reposted') || headerText.includes('shared')) continue;

                    const urn = container.getAttribute('data-urn') ||
                        container.querySelector('[data-urn]')?.getAttribute('data-urn') ||
                        `dom_${Date.now()}_${posts.length}`;

                    let reactions = 0, commentCount = 0, repostCount = 0;
                    const reactionsEl = container.querySelector(
                        '.social-details-social-counts__reactions-count, ' +
                        'span.social-details-social-counts__reactions-count'
                    );
                    if (reactionsEl) reactions = _parseCompact(reactionsEl.textContent);
                    const commentsEl = container.querySelector(
                        'button[aria-label*="comment"] span, ' +
                        '.social-details-social-counts__comments'
                    );
                    if (commentsEl) commentCount = _parseCompact(commentsEl.textContent);
                    const repostsEl = container.querySelector('button[aria-label*="repost"] span');
                    if (repostsEl) repostCount = _parseCompact(repostsEl.textContent);

                    let postedAt = null;
                    const timeEl = container.querySelector('time');
                    if (timeEl) postedAt = timeEl.getAttribute('datetime') || null;

                    if (!postedAt) {
                        const timeTextEl = container.querySelector(
                            '.update-components-actor__sub-description span[aria-hidden="true"], ' +
                            '.feed-shared-actor__sub-description span[aria-hidden="true"], ' +
                            '.update-components-actor__sub-description, ' +
                            '.feed-shared-actor__sub-description'
                        );
                        if (timeTextEl) {
                            const timeStr = timeTextEl.textContent.trim().split('•')[0].trim();
                            // 'mo' before 'm', 'yr' before 'y'
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
                    const authorEl = container.querySelector(
                        '.feed-shared-actor__name span, ' +
                        '.update-components-actor__name span'
                    );
                    if (authorEl) authorName = authorEl.textContent?.trim() || '';

                    const media = [];
                    const images = container.querySelectorAll(
                        '.feed-shared-image__image, .feed-shared-image img, .update-components-image img, .feed-shared-carousel img, .ivm-image-view-model img'
                    );
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

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
        }
    }
}
