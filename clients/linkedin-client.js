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
    //  PRIMARY: Direct Voyager API with cursor-based pagination
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
            // Navigate to the target profile page — it's stable and won't redirect away
            console.log(`  🌐 LinkedIn: Loading profile page for context...`);
            try {
                await page.goto(`https://www.linkedin.com/in/${profileSlug}/`, {
                    waitUntil: "domcontentloaded",
                    timeout: PAGE_LOAD_TIMEOUT,
                });
                await page.waitForTimeout(3000);
            } catch { /* page may still be usable */ }

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

            // Instead of using this.context.request (which can hit Max Redirects),
            // we execute the fetch natively INSIDE the Chromium page which already has perfect cookies/headers.
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

            // Step 2: Resolve the profile to get the author URN
            console.log(`  🔍 LinkedIn: Resolving profile for "${profileSlug}"...`);
            let profileUrn = null;
            try {
                const profileResp = await executeFetch(`https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`);

                if (profileResp.ok) {
                    const profileData = profileResp.data;
                    const elements = profileData?.included || profileData?.elements || [];
                    for (const el of elements) {
                        if (el.$type === "com.linkedin.voyager.dash.identity.profile.Profile" || el.entityUrn?.includes("fsd_profile")) {
                            profileUrn = el.entityUrn || el["*profile"];
                            break;
                        }
                    }
                    // Fallback: try to extract from data
                    if (!profileUrn) {
                        profileUrn = profileData?.data?.["*elements"]?.[0] ||
                            elements.find(e => e.entityUrn)?.entityUrn;
                    }
                }
            } catch (e) {
                console.log(`  ⚠️ Profile resolution failed: ${e.message}`);
            }

            // If we couldn't get the URN from the profile endpoint, construct it
            if (!profileUrn) {
                console.log(`  ℹ️ Using activity feed endpoint directly...`);
            }

            // Step 3: Fetch posts via the activity feed API
            console.log(`  📡 LinkedIn: Fetching posts via API (target: ${maxPosts})...`);
            const allPosts = [];
            let start = 0;
            const count = 40; // LinkedIn returns up to 40 per page
            let pageNum = 0;
            const maxPages = Math.ceil(maxPosts / count) + 5;
            let consecutiveEmpty = 0;

            while (allPosts.length < maxPosts && pageNum < maxPages) {
                pageNum++;

                // LinkedIn Voyager API for profile activity/posts
                let feedUrl = "";
                if (profileUrn) {
                    feedUrl = `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?count=${count}&profileUrn=${encodeURIComponent(profileUrn)}&q=memberShareFeed&start=${start}`;
                } else {
                    feedUrl = `https://www.linkedin.com/voyager/api/identity/dash/profileUpdates?` +
                        `q=memberShareFeed&memberIdentity=${profileSlug}` +
                        `&start=${start}&count=${count}` +
                        `&decorationId=com.linkedin.voyager.dash.deco.identity.profile.MemberShareFeedItem-5`;
                }

                let feedResp = await executeFetch(feedUrl);

                if (!feedResp.ok) {
                    // Secondary API fallback endpoint
                    const altUrl = `https://www.linkedin.com/voyager/api/feed/dash/feedUpdates?` +
                        `q=profileUpdatesByMemberIdentity&memberIdentity=${profileSlug}` +
                        `&start=${start}&count=${count}`;

                    feedResp = await executeFetch(altUrl);

                    if (!feedResp.ok) {
                        const errText = feedResp.data || feedResp.error || "";
                        console.log(`  ⚠️ LinkedIn API failed: ${errText.substring(0, 200)}`);
                        break;
                    }
                }

                const feedData = feedResp.data;
                if (!feedData) {
                    console.log(`  ⚠️ Failed to parse LinkedIn API response`);
                    break;
                }

                const posts = this._parseVoyagerPosts(feedData, profileSlug);

                if (posts.length === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 2) {
                        console.log(`  📊 LinkedIn: No more posts found (page ${pageNum}), stopping.`);
                        break;
                    }
                } else {
                    consecutiveEmpty = 0;
                }

                allPosts.push(...posts);
                start += count;

                if (pageNum % 5 === 0) {
                    console.log(`  📡 LinkedIn: ${allPosts.length} posts after ${pageNum} API pages...`);
                }

                // Respect rate limits
                await new Promise(r => setTimeout(r, 300 + Math.random() * 500));

                // Check if LinkedIn indicated no more results
                const paging = feedData?.paging || feedData?.data?.paging;
                if (paging && paging.total !== undefined && start >= paging.total) {
                    console.log(`  📊 LinkedIn: Reached end of feed (${paging.total} total).`);
                    break;
                }
            }

            // Dedup and sort
            const deduped = this._deduplicatePosts(allPosts);
            deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));

            console.log(`  ✅ LinkedIn: ${deduped.length} unique posts fetched via API (${pageNum} pages)`);
            return deduped.slice(0, maxPosts);

        } catch (error) {
            throw error;
        } finally {
            await page.close().catch(() => { });
        }
    }

    /**
     * Parse posts from LinkedIn's Voyager API response
     */
    _parseVoyagerPosts(feedData, profileSlug) {
        const posts = [];
        try {
            // LinkedIn's normalized JSON nests everything in "included"
            const included = feedData?.included || [];
            const elements = feedData?.elements || feedData?.data?.["*elements"] || [];

            // Build a lookup map of all included entities
            const entityMap = {};
            for (const item of included) {
                if (item.entityUrn || item.$recipeType) {
                    const key = item.entityUrn || item["*share"] || item.$id;
                    if (key) entityMap[key] = item;
                }
            }

            // Find all share/post objects across both arrays
            const allItems = [...included, ...elements];
            for (const item of allItems) {
                try {
                    // Look for share commentary (post text)
                    const commentary = item.commentary?.text?.text ||
                        item.commentary?.text ||
                        item.commentaryText?.text ||
                        null;

                    if (!commentary || commentary.length < 15) continue;

                    // Skip if it's a reshare/repost
                    if (item.resharedUpdate || item.resharedShare) continue;

                    // Extract engagement metrics
                    const socialDetail = item.socialDetail || {};
                    const totalReactions = socialDetail.totalSocialActivityCounts?.numLikes ||
                        socialDetail.likes?.paging?.total ||
                        item.numLikes || 0;
                    const commentCount = socialDetail.totalSocialActivityCounts?.numComments ||
                        socialDetail.comments?.paging?.total ||
                        item.numComments || 0;
                    const repostCount = socialDetail.totalSocialActivityCounts?.numShares ||
                        item.numShares || 0;

                    // Extract timestamp
                    let postedAt = null;
                    if (item.createdAt) {
                        postedAt = new Date(item.createdAt).toISOString();
                    } else if (item.created && typeof item.created.time === 'number') {
                        postedAt = new Date(item.created.time).toISOString();
                    } else if (item.publishedAt) {
                        postedAt = new Date(item.publishedAt).toISOString();
                    } else if (item.actor?.publishedAt) {
                        postedAt = new Date(item.actor.publishedAt).toISOString();
                    } else if (item.actor?.created && typeof item.actor.created.time === 'number') {
                        postedAt = new Date(item.actor.created.time).toISOString();
                    }

                    // Extract URN
                    const urn = item.entityUrn || item.urn ||
                        item["*share"] || item.shareUrn ||
                        `api_${Date.now()}_${posts.length}`;

                    // Extract author name
                    const authorName = item.actor?.name?.text ||
                        item.actor?.name ||
                        profileSlug;

                    // Determine post type (simple heuristic from content)
                    let postType = "text";
                    const content = item.content;
                    if (content) {
                        if (content["com.linkedin.voyager.feed.render.LinkedInVideoComponent"] ||
                            content.video || content["*video"]) {
                            postType = "video";
                        } else if (content["com.linkedin.voyager.feed.render.DocumentComponent"] ||
                            content.document || content["*document"]) {
                            postType = "carousel";
                        } else if (content["com.linkedin.voyager.feed.render.ImageComponent"] ||
                            content.images || content["*images"]) {
                            const imgCount = content.images?.length || 1;
                            postType = imgCount > 1 ? "carousel" : "image";
                        } else if (content["com.linkedin.voyager.feed.render.ArticleComponent"] ||
                            content.article || content["*article"]) {
                            postType = "article";
                        }
                    }

                    posts.push({
                        urn,
                        text: commentary,
                        totalReactions,
                        commentCount,
                        repostCount,
                        postedAt,
                        authorName,
                        type: postType,
                        media: null, // API doesn't give us direct media URLs easily
                    });
                } catch {
                    continue;
                }
            }
        } catch (err) {
            console.log(`  ⚠️ Voyager parse error: ${err.message}`);
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

        console.log(`  ⚠️ Bypassing LinkedIn profile API, directly using DOM...`);

        // Fallback to DOM
        const page = await this.context.newPage();
        try {
            const url = profileUrl.split('/recent-activity')[0].replace(/\/$/, "");
            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: PAGE_LOAD_TIMEOUT,
            });
            await page.waitForTimeout(2000);

            const profile = await page.evaluate(() => {
                let name = document.querySelector('h1.text-heading-xlarge')?.textContent?.trim() || "";
                if (!name) {
                    name = Array.from(document.querySelectorAll('h1, h2')).map(el => el.textContent?.trim()).find(text => text && text.length < 50 && !text.includes('notification')) || "";
                }
                let bio = document.querySelector('div.text-body-medium')?.textContent?.trim() ||
                    document.querySelector('.pv-text-details__left-panel .text-body-medium')?.textContent?.trim() || "";
                const image = document.querySelector('img.pv-top-card-profile-picture__image')?.getAttribute('src') ||
                    document.querySelector('img.pv-top-card-profile-picture__image--display')?.getAttribute('src') ||
                    Array.from(document.querySelectorAll('img')).map(el => el.getAttribute('src')).find(s => s && s.includes('profile-display')) || "";
                const followersText = document.body.textContent || "";
                let followersCount = 0;
                const match = followersText.match(/([\d,]+)\s*followers/i);
                if (match) followersCount = parseInt(match[1].replace(/,/g, ''), 10);
                return { name, bio, image, followersCount };
            });

            return profile;
        } catch (error) {
            console.error(`  ❌ Error fetching LinkedIn profile ${profileUrl}:`, error.message);
            return { name: "", bio: "", image: "", followersCount: 0 };
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
