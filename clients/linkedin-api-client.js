/**
 * LinkedInApiClient — Direct Voyager API client (NO BROWSER)
 *
 * Makes direct HTTP requests to LinkedIn's Voyager API, routing through
 * a residential proxy (ScrapeOps). No Playwright or browser needed.
 *
 * RATE LIMITING STRATEGY:
 *   - Token bucket: max 8 requests/window, refills every 10s
 *   - Minimum 600ms gap between any two requests
 *   - On 429: exponential backoff starting at 60s, up to 5 retries
 *   - Inter-page delay: 1-2.5s with jitter
 *
 * USAGE:
 *   const client = new LinkedInApiClient(accountPair);
 *   client.initialize();
 *   const { profile, posts } = await client.fetchCreatorFull('whyismail', 500);
 *   await client.cleanup();
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { randomUUID } from 'crypto';

// ─── Rate Limit Config ────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 25000;
const MIN_REQUEST_GAP_MS = 600;       // minimum ms between any two requests
const TOKEN_BUCKET_MAX = 8;         // max burst requests
const TOKEN_BUCKET_REFILL_MS = 10000; // refill bucket every 10s
const MAX_429_RETRIES = 5;         // max retries on rate limit
const BASE_BACKOFF_MS = 60000;     // 60s base backoff on 429

export class LinkedInApiClient {
    /**
     * @param {object} [accountPair] — from LinkedInAccountPool. Falls back to env vars if null.
     */
    constructor(accountPair = null) {
        this._agent = null;
        this._stickySessionId = randomUUID().replace(/-/g, '').substring(0, 16);

        // Token bucket for rate limiting
        this._tokenBucket = TOKEN_BUCKET_MAX;
        this._lastTokenRefill = Date.now();
        this._lastRequestTime = 0;

        if (accountPair) {
            this._liAt = accountPair.liAt;
            this._jsessionId = accountPair.jsessionId || '';
            this._proxyServer = accountPair.proxyServer || '';
            this._proxyUsername = accountPair.proxyUsername || '';
            this._proxyPassword = accountPair.proxyPassword || '';
            this._label = accountPair.label || 'injected';
        } else {
            this._liAt = process.env.LINKEDIN_LI_AT_COOKIE || '';
            this._jsessionId = process.env.LINKEDIN_JSESSIONID?.replace(/"/g, '') || '';
            this._proxyServer = process.env.PROXY_SERVER || '';
            this._proxyUsername = process.env.PROXY_USERNAME || '';
            this._proxyPassword = process.env.PROXY_PASSWORD || '';
            this._label = 'legacy-env';
        }

        this._liAt = this._liAt.trim().replace(/^["']|["']$/g, '');
        this._jsessionId = this._jsessionId.replace(/"/g, '').trim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Initialization
    // ═══════════════════════════════════════════════════════════════════

    initialize() {
        if (!this._liAt) throw new Error(`[${this._label}] No li_at cookie configured`);

        if (this._proxyServer) {
            let proxyUsername = this._proxyUsername;
            if (proxyUsername.startsWith('scrapeops.') && !proxyUsername.includes('.session=')) {
                proxyUsername = `${proxyUsername}.session=${this._stickySessionId}`;
            }
            const proxyUrl = new URL(this._proxyServer);
            proxyUrl.username = encodeURIComponent(proxyUsername);
            proxyUrl.password = encodeURIComponent(this._proxyPassword);
            this._agent = new ProxyAgent(proxyUrl.toString());
            console.log(`  🔀 [${this._label}] Proxy: ${this._proxyServer} (session: ${this._stickySessionId})`);
        } else {
            console.log(`  🌐 [${this._label}] Direct connection (no proxy)`);
        }

        console.log(`✅ [${this._label}] LinkedIn API client ready`);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Rate Limiting — Token Bucket
    // ═══════════════════════════════════════════════════════════════════

    async _acquireToken() {
        // Refill bucket based on elapsed time
        const now = Date.now();
        const elapsed = now - this._lastTokenRefill;
        if (elapsed >= TOKEN_BUCKET_REFILL_MS) {
            const refills = Math.floor(elapsed / TOKEN_BUCKET_REFILL_MS);
            this._tokenBucket = Math.min(TOKEN_BUCKET_MAX, this._tokenBucket + refills);
            this._lastTokenRefill = now;
        }

        // If bucket empty, wait for next refill
        if (this._tokenBucket <= 0) {
            const waitMs = TOKEN_BUCKET_REFILL_MS - (Date.now() - this._lastTokenRefill) + 100;
            console.log(`  🪣 [${this._label}] Rate bucket empty — waiting ${(waitMs / 1000).toFixed(1)}s`);
            await this._sleep(waitMs);
            this._tokenBucket = TOKEN_BUCKET_MAX;
            this._lastTokenRefill = Date.now();
        }

        // Enforce minimum gap between requests
        const gap = Date.now() - this._lastRequestTime;
        if (gap < MIN_REQUEST_GAP_MS) {
            await this._sleep(MIN_REQUEST_GAP_MS - gap + Math.random() * 200);
        }

        this._tokenBucket--;
        this._lastRequestTime = Date.now();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  HTTP Layer
    // ═══════════════════════════════════════════════════════════════════

    _buildHeaders(referer = 'https://www.linkedin.com/feed/') {
        const csrf = this._jsessionId || 'ajax:0';
        const cookieParts = [`li_at=${this._liAt}`];
        if (this._jsessionId) cookieParts.push(`JSESSIONID="${this._jsessionId}"`);

        return {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
            'cookie': cookieParts.join('; '),
            'csrf-token': csrf,
            'pragma': 'no-cache',
            'referer': referer,
            'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'x-li-lang': 'en_US',
            'x-li-page-instance': 'urn:li:page:d_flagship3_profile_view_base_recent_activity_content_view;brandled',
            'x-li-track': JSON.stringify({ clientVersion: '1.13.42584', mpVersion: '1.13.42584', osName: 'web', timezoneOffset: -5, timezone: 'America/New_York', deviceFormFactor: 'DESKTOP', mpName: 'voyager-web', displayDensity: 1, displayWidth: 1920, displayHeight: 1080 }),
            'x-restli-protocol-version': '2.0.0',
        };
    }

    async _apiGet(url) {
        await this._acquireToken();

        const fetchOptions = {
            method: 'GET',
            headers: this._buildHeaders(),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        };
        if (this._agent) fetchOptions.dispatcher = this._agent;

        let backoffMs = BASE_BACKOFF_MS;

        for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
            try {
                const res = await undiciFetch(url, fetchOptions);
                const text = await res.text();

                // Auth failure — cookie expired, don't retry
                if (res.status === 401 || res.status === 403) {
                    console.log(`  ⚠️ [${this._label}] ${res.status} — cookie expired or unauthorized`);
                    return { ok: false, status: res.status, data: null };
                }

                // Rate limit — exponential backoff
                if (res.status === 429) {
                    const serverWait = parseInt(res.headers.get('retry-after') || '0') * 1000;
                    const waitMs = Math.max(serverWait, backoffMs) + Math.random() * 5000;
                    console.log(`  ⏳ [${this._label}] 429 Rate limited (attempt ${attempt}). Backing off ${(waitMs / 1000).toFixed(0)}s...`);
                    if (attempt > MAX_429_RETRIES) {
                        return { ok: false, status: 429, data: null };
                    }
                    await this._sleep(waitMs);
                    backoffMs = Math.min(backoffMs * 2, 600000); // cap at 10 min
                    await this._acquireToken();
                    continue;
                }

                if (!res.ok) {
                    console.log(`  ⚠️ [${this._label}] API ${res.status}: ${text.substring(0, 80)}`);
                    return { ok: false, status: res.status, data: null };
                }

                try {
                    return { ok: true, status: res.status, data: JSON.parse(text) };
                } catch {
                    console.log(`  ⚠️ [${this._label}] JSON parse error for: ${url.substring(0, 80)}`);
                    return { ok: false, status: res.status, data: null };
                }

            } catch (err) {
                const isTimeout = err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT';
                if (attempt <= MAX_429_RETRIES) {
                    const waitMs = 3000 * attempt + Math.random() * 2000;
                    console.log(`  ⚠️ [${this._label}] ${isTimeout ? 'Timeout' : 'Fetch error'} (attempt ${attempt}), retrying in ${(waitMs / 1000).toFixed(1)}s...`);
                    await this._sleep(waitMs);
                } else {
                    console.log(`  ❌ [${this._label}] Failed: ${err.message.substring(0, 100)}`);
                    return { ok: false, status: 0, error: err.message };
                }
            }
        }
        return { ok: false, status: 0, error: 'Max retries exceeded' };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ★ PRIMARY METHOD: fetchCreatorFull
    //  Returns BOTH profile details AND posts in one call.
    //  Used for initial onboarding scrape.
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param {string} profileUrl  - LinkedIn profile URL or username slug
     * @param {number} maxPosts    - Max posts to fetch (default 500 for onboarding)
     * @returns {{ profile: ProfileData, posts: Post[] }}
     */
    async fetchCreatorFull(profileUrl, maxPosts = 500) {
        const profileSlug = this._extractProfileSlug(profileUrl);
        console.log(`\n  🚀 [${this._label}] Full scrape of "${profileSlug}" (max ${maxPosts} posts)`);

        // Fetch profile and URN in one API call
        const { profile, profileUrn } = await this._fetchProfileAndUrn(profileSlug);

        // Fetch posts
        const posts = profileUrn
            ? await this._paginatePosts(profileUrn, profileSlug, maxPosts)
            : await this._fetchPostsViaActivityAPI(profileSlug, maxPosts);

        return { profile, posts };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Profile: fetch details + URN in one shot
    // ═══════════════════════════════════════════════════════════════════

    async _fetchProfileAndUrn(profileSlug) {
        console.log(`  👤 [${this._label}] Fetching profile: ${profileSlug}`);

        // Decoration that returns name, headline, photo, networkInfo (followers)
        const resp = await this._apiGet(
            `https://www.linkedin.com/voyager/api/identity/dash/profiles` +
            `?q=memberIdentity&memberIdentity=${encodeURIComponent(profileSlug)}` +
            `&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`
        );

        let profile = {
            slug: profileSlug,
            name: profileSlug,
            firstName: '',
            lastName: '',
            headline: '',
            profileImageUrl: '',
            followersCount: 0,
            connectionsCount: 0,
        };

        let profileUrn = null;

        if (!resp.ok || !resp.data) {
            console.log(`  ⚠️ [${this._label}] Profile fetch failed (${resp.status})`);
            return { profile, profileUrn };
        }

        try {
            const included = resp.data?.included || [];

            // Extract URN from *elements
            const elements = resp.data?.data?.['*elements'] || [];
            if (elements.length > 0) profileUrn = elements[0];

            // Find profile entity
            const profileEntity = included.find(i =>
                (i.$type === 'com.linkedin.voyager.dash.identity.profile.Profile' ||
                    i.$type?.includes('.Profile')) &&
                (i.publicIdentifier === profileSlug || i.firstName)
            );

            if (profileEntity) {
                if (!profileUrn && profileEntity.entityUrn) profileUrn = profileEntity.entityUrn;

                profile.firstName = profileEntity.firstName || '';
                profile.lastName = profileEntity.lastName || '';
                profile.name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profileSlug;
                profile.headline = profileEntity.headline || profileEntity.occupation || '';

                // Profile image — walk the nested structure
                const photoRef = profileEntity.profilePicture
                    || profileEntity.photo
                    || profileEntity.image;

                if (photoRef) {
                    const artifacts =
                        photoRef?.displayImageReference?.vectorImage?.artifacts ||
                        photoRef?.displayImageWithFrameReference?.artifacts ||
                        photoRef?.croppedImage?.artifacts ||
                        photoRef?.artifacts;

                    const rootUrl =
                        photoRef?.displayImageReference?.vectorImage?.rootUrl ||
                        photoRef?.displayImageWithFrameReference?.rootUrl ||
                        photoRef?.croppedImage?.rootUrl ||
                        photoRef?.rootUrl ||
                        '';

                    if (Array.isArray(artifacts) && artifacts.length > 0) {
                        // Pick the highest resolution artifact
                        const best = artifacts.reduce((a, b) =>
                            (b.width || 0) > (a.width || 0) ? b : a
                        );
                        const segment = best.fileIdentifyingUrlPathSegment || '';
                        profile.profileImageUrl = segment.startsWith('http')
                            ? segment
                            : `${rootUrl}${segment}`;
                    }
                }
            }

            // Scan ALL included items for follower/connection counts
            // LinkedIn returns these under several different $type keys
            for (const item of included) {
                if (item.followersCount > 0) profile.followersCount = item.followersCount;
                if (item.followerCount > 0) profile.followersCount = item.followerCount;
                if (item.connectionsCount > 0) profile.connectionsCount = item.connectionsCount;
                if (item.connectionCount > 0) profile.connectionsCount = item.connectionCount;
            }

            if (profileUrn) {
                console.log(`  ✅ [${this._label}] Profile: ${profile.name} | ${profile.headline?.substring(0, 60)} | 👥 ${profile.followersCount} followers`);
            }

        } catch (err) {
            console.log(`  ⚠️ [${this._label}] Profile parse error: ${err.message}`);
        }

        // If follower count still 0, try the real LinkedIn GraphQL profile cards endpoint
        if (profile.followersCount === 0) {
            await this._enrichFollowerCount(profileSlug, profile, profileUrn);
        }

        console.log(`  ✅ [${this._label}] Profile ready: ${profile.name} | 👥 ${profile.followersCount} followers`);
        return { profile, profileUrn };
    }

    /**
     * Fetch follower count via the exact GraphQL endpoint LinkedIn uses.
     * The CONTENT_COLLECTIONS_DETAILS section returns FollowingState entities
     * in `included` that carry `followerCount`.
     *
     * FollowingState hashed type: com.linkedin.18bcd573947ab8d26d15c385f0214d78
     * (== com.linkedin.voyager.dash.feed.FollowingState)
     *
     * queryId: voyagerIdentityDashProfileCards.d96bceb7c9c096c42442379b2e37486a
     */
    async _enrichFollowerCount(profileSlug, profile, profileUrn) {
        if (!profileUrn) return;
        console.log(`  🔍 [${this._label}] Fetching follower count via profile cards (CONTENT_COLLECTIONS_DETAILS)...`);

        const encodedUrn = encodeURIComponent(profileUrn);
        const url =
            `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true` +
            `&variables=(profileUrn:${encodedUrn},sectionType:CONTENT_COLLECTIONS_DETAILS)` +
            `&queryId=voyagerIdentityDashProfileCards.d96bceb7c9c096c42442379b2e37486a`;

        const resp = await this._apiGet(url);
        if (!resp.ok || !resp.data) return;

        try {
            const included = resp.data?.included || [];

            // Debug: log all $type values seen (helps diagnose if type string changes)
            const types = [...new Set(included.map(i => i.$type).filter(Boolean))];
            if (types.length) {
                console.log(`  🔬 [${this._label}] included $types: ${types.slice(0, 8).join(', ')}`);
            } else {
                console.log(`  ⚠️ [${this._label}] included array is empty — follower count unavailable`);
                return;
            }

            for (const item of included) {
                const t = item.$type || '';
                // Match either the hashed form or the full display name
                const isFollowingState =
                    t === 'com.linkedin.18bcd573947ab8d26d15c385f0214d78' ||
                    t === 'com.linkedin.voyager.dash.feed.FollowingState';

                if (isFollowingState && item.followerCount !== undefined) {
                    profile.followersCount = item.followerCount || 0;
                    if (item.followeeCount !== undefined) {
                        profile.followingCount = item.followeeCount || 0;
                    }
                    console.log(`  📊 [${this._label}] FollowingState → ${profile.followersCount} followers`);
                    return;
                }

                // Broad fallback — pick up any entity that has followerCount
                if (item.followerCount > 0) profile.followersCount = item.followerCount;
                if (item.followersCount > 0) profile.followersCount = item.followersCount;
            }

            if (profile.followersCount > 0) {
                console.log(`  📊 [${this._label}] Followers (broad scan): ${profile.followersCount}`);
            } else {
                console.log(`  ⚠️ [${this._label}] Follower count not found in any included entity`);
            }
        } catch (err) {
            console.log(`  ⚠️ [${this._label}] Follower parse error: ${err.message}`);
        }
    }

    // Public alias for profile-only fetches
    async fetchCreatorProfile(profileUrl) {
        const profileSlug = this._extractProfileSlug(profileUrl);
        const { profile } = await this._fetchProfileAndUrn(profileSlug);
        return profile;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Posts: paginated GraphQL feed
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorPosts(profileUrl, maxPosts = 25) {
        const profileSlug = this._extractProfileSlug(profileUrl);
        const profileUrn = await this._resolveProfileUrn(profileSlug);
        return profileUrn
            ? this._paginatePosts(profileUrn, profileSlug, maxPosts)
            : this._fetchPostsViaActivityAPI(profileSlug, maxPosts);
    }

    async _resolveProfileUrn(profileSlug) {
        const { profileUrn } = await this._fetchProfileAndUrn(profileSlug);
        return profileUrn;
    }

    async _paginatePosts(profileUrn, profileSlug, maxPosts) {
        const isUnlimited = maxPosts >= 10000;
        const effectiveMax = isUnlimited ? Infinity : maxPosts;
        const maxPages = isUnlimited ? 200 : Math.min(Math.ceil(maxPosts / 20) + 2, 200);
        const count = 20;

        console.log(`  📡 [${this._label}] Paginating posts (target: ${isUnlimited ? 'ALL' : maxPosts}, max ${maxPages} pages)...`);

        const allPosts = [];
        const seenUrns = new Set();
        let start = 0;
        let paginationToken = null;
        let pageNum = 0;
        let consecutiveEmpty = 0;
        const startTime = Date.now();

        while (allPosts.length < effectiveMax && pageNum < maxPages) {
            pageNum++;

            const variables = paginationToken && pageNum > 1
                ? `(count:${count},start:${start},paginationToken:${encodeURIComponent(paginationToken)},profileUrn:${encodeURIComponent(profileUrn)})`
                : `(count:${count},start:${start},profileUrn:${encodeURIComponent(profileUrn)})`;

            const feedUrl =
                `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true` +
                `&variables=${variables}` +
                `&queryId=voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822`;

            const feedResp = await this._apiGet(feedUrl);

            if (!feedResp.ok || !feedResp.data) {
                console.log(`  ⚠️ [${this._label}] Feed page ${pageNum} failed (${feedResp.status})`);
                if (feedResp.status === 429) break; // already backed off, give up cleanly
                break;
            }

            // Extract pagination token for next page
            const meta = feedResp.data?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.metadata;
            if (meta?.paginationToken) paginationToken = meta.paginationToken;

            const pagePosts = this._parseGraphQLPosts(feedResp.data, profileSlug);
            let newCount = 0;
            for (const p of pagePosts) {
                if (!seenUrns.has(p.urn)) {
                    seenUrns.add(p.urn);
                    allPosts.push(p);
                    newCount++;
                }
            }

            const rawUpdates = (feedResp.data?.included || []).filter(
                i => i.$type === 'com.linkedin.voyager.dash.feed.Update'
            ).length;

            // Progress every 5 pages
            if (pageNum % 5 === 0 || rawUpdates === 0) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`  📊 [${this._label}] Page ${pageNum}: ${allPosts.length} posts (${elapsed}s)`);
            }

            if (rawUpdates === 0) {
                console.log(`  ℹ️ [${this._label}] No more updates — end of feed`);
                break;
            }

            if (newCount === 0) {
                if (++consecutiveEmpty >= 3) {
                    console.log(`  ℹ️ [${this._label}] 3 consecutive empty pages — stopping`);
                    break;
                }
            } else {
                consecutiveEmpty = 0;
            }

            start += count;

            // Check paging total
            const paging = meta?.paging || feedResp.data?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.paging;
            if (paging?.total > 0 && start >= paging.total) {
                console.log(`  ℹ️ [${this._label}] Reached paging total (${paging.total})`);
                break;
            }

            // Inter-page delay with jitter — varies to appear human-like
            const delay = pageNum <= 3
                ? 1200 + Math.random() * 1300   // first 3 pages: 1.2–2.5s
                : 700 + Math.random() * 1000;   // subsequent: 0.7–1.7s
            await this._sleep(delay);
        }

        const deduped = this._deduplicatePosts(allPosts);
        deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  ✅ [${this._label}] ${deduped.length} posts in ${elapsed}s (${pageNum} pages)`);
        return isUnlimited ? deduped : deduped.slice(0, maxPosts);
    }

    async _fetchPostsViaActivityAPI(profileSlug, maxPosts) {
        console.log(`  📡 [${this._label}] Activity API fallback for "${profileSlug}"...`);

        const url =
            `https://www.linkedin.com/voyager/api/feed/dash/profiles/updates` +
            `?profileUrn=urn:li:fsd_profile:${profileSlug}` +
            `&q=memberShareFeed&moduleKey=member-shares:phone&count=${Math.min(maxPosts, 50)}&start=0`;

        const resp = await this._apiGet(url);
        if (resp.ok && resp.data) return this._parseGraphQLPosts(resp.data, profileSlug);

        throw new Error(`Activity API failed (${resp.status})`);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Parsing
    // ═══════════════════════════════════════════════════════════════════

    _parseGraphQLPosts(feedData, profileSlug) {
        const posts = [];
        try {
            const included = feedData?.included || [];

            // Build social activity counts map keyed by activity URN
            const countsMap = {};
            for (const item of included) {
                if (item.$type === 'com.linkedin.voyager.dash.feed.SocialActivityCounts') {
                    const key = (item.urn || item.entityUrn || '')
                        .replace('urn:li:fsd_socialActivityCounts:', '');
                    countsMap[key] = item;
                }
            }

            const updates = included.filter(i => i.$type === 'com.linkedin.voyager.dash.feed.Update');

            for (const item of updates) {
                try {
                    const commentary = item.commentary?.text?.text;
                    if (!commentary || commentary.length < 5) continue;
                    // Skip shallow reshares
                    if (item.resharedUpdate && commentary.length < 50) continue;

                    const activityMatch = item.entityUrn?.match(/urn:li:activity:(\d+)/);
                    const activityUrn = activityMatch ? `urn:li:activity:${activityMatch[1]}` : '';
                    const counts = countsMap[activityUrn] || countsMap[item.entityUrn || ''] || {};

                    // Decode timestamp from LinkedIn snowflake ID
                    let postedAt = null;
                    if (activityMatch) {
                        const ts = Number(BigInt(activityMatch[1]) >> 22n);
                        if (ts > 1_000_000_000_000) postedAt = new Date(ts).toISOString();
                    }

                    // Detect media type
                    let postType = 'text';
                    const content = item.content;
                    if (content) {
                        if (content.videoComponent) postType = 'video';
                        else if (content.documentComponent) postType = 'carousel';
                        else if (content.imageComponent) postType = 'image';
                        else if (content.articleComponent) postType = 'article';
                    }

                    posts.push({
                        urn: item.entityUrn || activityUrn || `api_${Date.now()}_${posts.length}`,
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
            console.log(`  ⚠️ [${this._label}] Parse error: ${err.message}`);
        }
        return posts;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Utilities
    // ═══════════════════════════════════════════════════════════════════

    _extractProfileSlug(profileUrl) {
        if (!profileUrl?.includes('/')) return profileUrl;
        const match = profileUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
        return match ? match[1] : profileUrl;
    }

    _deduplicatePosts(posts) {
        const seen = new Set();
        return posts.filter(p => {
            if (seen.has(p.urn)) return false;
            seen.add(p.urn);
            return true;
        });
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    cleanup() {
        if (this._agent) {
            this._agent.destroy().catch(() => { });
            this._agent = null;
        }
    }
}
