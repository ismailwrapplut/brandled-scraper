/**
 * LinkedInApiClient — Direct Voyager API client (NO BROWSER)
 *
 * Makes direct HTTP requests to LinkedIn's Voyager API, routing through
 * a residential proxy (ScrapeOps). No Playwright or browser needed.
 *
 * WHY THIS WORKS:
 *   - Traffic is routed through a residential proxy, so LinkedIn sees a
 *     real consumer IP. TLS terminates at the proxy, bypassing TLS fingerprinting.
 *   - We send exact Chrome headers (captured from a real browser session).
 *   - No browser startup overhead — 10x faster per scrape.
 *
 * REQUIREMENTS:
 *   - A valid li_at cookie (refresh from your browser when expired)
 *   - ScrapeOps residential proxy credentials in .env
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { randomUUID } from 'crypto';

const FETCH_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;

export class LinkedInApiClient {
    /**
     * @param {object} [accountPair] — from LinkedInAccountPool. Falls back to env vars if null.
     */
    constructor(accountPair = null) {
        this._agent = null;
        this._stickySessionId = randomUUID().replace(/-/g, '').substring(0, 16);

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

        // Clean up cookie values
        this._liAt = this._liAt.trim().replace(/^["']|["']$/g, '');
        this._jsessionId = this._jsessionId.replace(/"/g, '').trim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Initialization
    // ═══════════════════════════════════════════════════════════════════

    initialize() {
        if (!this._liAt) throw new Error(`[${this._label}] No li_at cookie configured`);

        if (this._proxyServer) {
            // Build ScrapeOps sticky session proxy URL
            // Format: http://scrapeops.country=us.session=<id>:<apikey>@residential-proxy.scrapeops.io:8181
            let proxyUsername = this._proxyUsername;
            if (proxyUsername.startsWith('scrapeops.') && !proxyUsername.includes('.session=')) {
                proxyUsername = `${proxyUsername}.session=${this._stickySessionId}`;
            }

            // Build the authenticated proxy URL
            const proxyUrl = new URL(this._proxyServer);
            proxyUrl.username = encodeURIComponent(proxyUsername);
            proxyUrl.password = encodeURIComponent(this._proxyPassword);

            this._agent = new ProxyAgent(proxyUrl.toString());
            console.log(`  🔀 [${this._label}] Proxy: ${this._proxyServer} (session: ${this._stickySessionId})`);
        } else {
            console.log(`  🌐 [${this._label}] No proxy — using direct connection`);
        }

        console.log(`✅ [${this._label}] LinkedIn API client ready (no browser)`);
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

    async _apiGet(url, retries = MAX_RETRIES) {
        const fetchOptions = {
            method: 'GET',
            headers: this._buildHeaders(`https://www.linkedin.com/in/${url.includes('memberIdentity') ? '' : 'feed'}/`),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        };

        if (this._agent) {
            fetchOptions.dispatcher = this._agent;
        }

        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            try {
                const res = await undiciFetch(url, fetchOptions);
                const text = await res.text();

                if (res.status === 401 || res.status === 403) {
                    console.log(`  ⚠️ [${this._label}] API ${res.status} — cookie may be expired`);
                    return { ok: false, status: res.status, data: null };
                }

                if (res.status === 429) {
                    const retryAfter = res.headers.get('retry-after') || '30';
                    console.log(`  ⚠️ [${this._label}] Rate limited (429). Waiting ${retryAfter}s...`);
                    await this._sleep(parseInt(retryAfter) * 1000);
                    continue;
                }

                if (!res.ok) {
                    console.log(`  ⚠️ [${this._label}] API ${res.status}: ${text.substring(0, 100)}`);
                    return { ok: false, status: res.status, data: null };
                }

                try {
                    return { ok: true, status: res.status, data: JSON.parse(text) };
                } catch {
                    console.log(`  ⚠️ [${this._label}] Failed to parse JSON response`);
                    return { ok: false, status: res.status, data: null };
                }
            } catch (err) {
                if (attempt <= retries) {
                    console.log(`  ⚠️ [${this._label}] Fetch error (attempt ${attempt}): ${err.message.substring(0, 100)}, retrying...`);
                    await this._sleep(2000 * attempt);
                } else {
                    console.log(`  ❌ [${this._label}] Fetch failed after ${attempt} attempts: ${err.message.substring(0, 100)}`);
                    return { ok: false, status: 0, error: err.message };
                }
            }
        }
        return { ok: false, status: 0, error: 'Max retries exceeded' };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Profile URN Resolution
    // ═══════════════════════════════════════════════════════════════════

    async _resolveProfileUrn(profileSlug) {
        console.log(`  🔍 [${this._label}] Resolving URN for "${profileSlug}"...`);

        const resp = await this._apiGet(
            `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(profileSlug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`
        );

        if (!resp.ok || !resp.data) {
            console.log(`  ❌ [${this._label}] URN resolution failed (${resp.status})`);
            return null;
        }

        // Try *elements first (most reliable)
        const elements = resp.data?.data?.['*elements'];
        if (Array.isArray(elements) && elements.length > 0) {
            console.log(`  ✅ [${this._label}] URN resolved: ${elements[0]}`);
            return elements[0];
        }

        // Try included array
        const included = resp.data?.included || [];
        const entity = included.find(i =>
            i.$type === 'com.linkedin.voyager.dash.identity.profile.Profile' &&
            i.entityUrn &&
            i.publicIdentifier === profileSlug
        );
        if (entity) {
            console.log(`  ✅ [${this._label}] URN resolved (included): ${entity.entityUrn}`);
            return entity.entityUrn;
        }

        console.log(`  ❌ [${this._label}] Could not extract URN from response`);
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Main: fetchCreatorPosts
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorPosts(profileUrl, maxPosts = 25) {
        const profileSlug = this._extractProfileSlug(profileUrl);
        if (!profileSlug) throw new Error(`Could not extract slug from: ${profileUrl}`);

        // Step 1: Resolve URN
        const profileUrn = await this._resolveProfileUrn(profileSlug);
        if (!profileUrn) {
            // Try activity API as fallback (doesn't need URN)
            console.log(`  ⚠️ [${this._label}] URN failed, trying activity API...`);
            return this._fetchPostsViaActivityAPI(profileSlug, maxPosts);
        }

        // Step 2: Paginate through GraphQL feed
        console.log(`  📡 [${this._label}] Fetching posts via GraphQL (target: ${maxPosts})...`);
        const allPosts = [];
        const seenUrns = new Set();
        let start = 0;
        let paginationToken = null;
        const count = 20;
        let pageNum = 0;
        const maxPages = Math.min(Math.ceil(maxPosts / count) + 3, 10);
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

            if (!feedResp.ok || !feedResp.data) {
                console.log(`  ⚠️ [${this._label}] GraphQL page ${pageNum} failed (${feedResp.status})`);
                break;
            }

            // Extract pagination token
            const feedMeta = feedResp.data?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.metadata;
            if (feedMeta?.paginationToken) paginationToken = feedMeta.paginationToken;

            const posts = this._parseGraphQLPosts(feedResp.data, profileSlug);

            let newCount = 0;
            for (const p of posts) {
                if (!seenUrns.has(p.urn)) {
                    seenUrns.add(p.urn);
                    allPosts.push(p);
                    newCount++;
                }
            }

            const rawUpdateCount = (feedResp.data?.included || []).filter(
                i => i.$type === 'com.linkedin.voyager.dash.feed.Update'
            ).length;
            if (rawUpdateCount === 0) break;

            if (newCount === 0) {
                if (++consecutiveEmpty >= 3) break;
            } else {
                consecutiveEmpty = 0;
            }

            start += count;

            // Human-like delay between pages
            await this._sleep(1500 + Math.random() * 2000);

            const paging = feedResp.data?.data?.data?.feedDashProfileUpdatesByMemberShareFeed?.paging || feedResp.data?.data?.paging;
            if (paging?.total !== undefined && paging.total > 0 && start >= paging.total) break;
        }

        const deduped = this._deduplicatePosts(allPosts);
        deduped.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
        console.log(`  ✅ [${this._label}] ${deduped.length} posts via GraphQL (${pageNum} pages)`);
        return deduped.slice(0, maxPosts);
    }

    async _fetchPostsViaActivityAPI(profileSlug, maxPosts) {
        console.log(`  📡 [${this._label}] Trying activity API for "${profileSlug}"...`);

        const url =
            `https://www.linkedin.com/voyager/api/feed/dash/profiles/updates` +
            `?profileUrn=urn:li:fsd_profile:${profileSlug}` +
            `&q=memberShareFeed&moduleKey=member-shares:phone&count=${Math.min(maxPosts, 50)}&start=0`;

        const resp = await this._apiGet(url);
        if (resp.ok && resp.data) return this._parseGraphQLPosts(resp.data, profileSlug);

        // Older endpoint fallback
        const altUrl =
            `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2` +
            `?profileId=${profileSlug}&q=memberShareFeed&moduleKey=member-shares:phone` +
            `&count=${Math.min(maxPosts, 50)}&start=0`;

        const altResp = await this._apiGet(altUrl);
        if (altResp.ok && altResp.data) return this._parseGraphQLPosts(altResp.data, profileSlug);

        throw new Error(`Activity API failed (${resp.status}, alt ${altResp.status})`);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Profile Fetching
    // ═══════════════════════════════════════════════════════════════════

    async fetchCreatorProfile(profileUrl) {
        const profileSlug = this._extractProfileSlug(profileUrl);
        const resp = await this._apiGet(
            `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-18`
        );

        if (!resp.ok || !resp.data) return { name: profileSlug, bio: '', image: '', followersCount: 0 };

        const included = resp.data?.included || [];
        const profile = included.find(i =>
            i.$type === 'com.linkedin.voyager.dash.identity.profile.Profile' &&
            i.publicIdentifier === profileSlug
        );

        if (!profile) return { name: profileSlug, bio: '', image: '', followersCount: 0 };

        const networkInfo = included.find(i => i.$type?.includes('NetworkInfo') || i.followersCount !== undefined);

        return {
            name: [profile.firstName, profile.lastName].filter(Boolean).join(' '),
            bio: profile.headline || '',
            image: profile.profilePicture?.displayImageReference?.vectorImage?.artifacts?.[0]?.fileIdentifyingUrlPathSegment || '',
            followersCount: networkInfo?.followersCount || 0,
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Parsing (same logic as linkedin-client.js)
    // ═══════════════════════════════════════════════════════════════════

    _parseGraphQLPosts(feedData, profileSlug) {
        const posts = [];
        try {
            const included = feedData?.included || [];

            const countsMap = {};
            for (const item of included) {
                if (item.$type === 'com.linkedin.voyager.dash.feed.SocialActivityCounts') {
                    const activityUrn = item.urn || item.entityUrn?.replace('urn:li:fsd_socialActivityCounts:', '') || '';
                    countsMap[activityUrn] = item;
                }
            }

            const updates = included.filter(i => i.$type === 'com.linkedin.voyager.dash.feed.Update');

            for (const item of updates) {
                try {
                    const commentary = item.commentary?.text?.text;
                    if (!commentary || commentary.length < 5) continue;
                    if (item.resharedUpdate && (!commentary || commentary.length < 50)) continue;

                    let activityUrn = '';
                    const activityMatch = item.entityUrn?.match(/urn:li:activity:(\d+)/);
                    if (activityMatch) activityUrn = `urn:li:activity:${activityMatch[1]}`;

                    const counts = countsMap[activityUrn] || {};

                    let postedAt = null;
                    if (activityMatch) {
                        const ts = Number(BigInt(activityMatch[1]) >> 22n);
                        if (ts > 1000000000000) postedAt = new Date(ts).toISOString();
                    }

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
        if (!profileUrl.includes('/')) return profileUrl;
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
