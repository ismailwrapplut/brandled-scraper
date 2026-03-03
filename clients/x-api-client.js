/**
 * XApiClient — Direct GraphQL API client (NO BROWSER / NO PLAYWRIGHT)
 *
 * Makes direct HTTP requests to X's internal GraphQL API, using
 * auth_token + ct0 cookies read from environment variables.
 *
 * HOW TO GET YOUR COOKIES:
 *   1. Open x.com in Chrome, log in
 *   2. Open DevTools → Application → Cookies → https://x.com
 *   3. Copy the value of `auth_token`  → TWITTER_AUTH_TOKEN in .env
 *   4. Copy the value of `ct0`         → TWITTER_CT0 in .env
 *   (These cookies last ~1 year; refresh them if requests start failing with 403)
 *
 * RATE LIMITING STRATEGY:
 *   - Minimum 500ms gap between any two requests
 *   - On 429: exponential backoff starting at 60s, up to 5 min
 *   - Inter-page delay: 500ms–1s with jitter (3–5s when throttled)
 *
 * USAGE:
 *   const client = new XApiClient();
 *   client.initialize();
 *   const profile = await client.fetchCreatorProfile('thejustinwelsh');
 *   const tweets  = await client.fetchCreatorTweets('thejustinwelsh', 30);
 *   client.cleanup();
 */

// Proxy support (optional — same pattern as linkedin-api-client)
let _ProxyAgent = null;
let _undiciFetch = null;
try {
    const undici = await import('undici');
    _ProxyAgent = undici.ProxyAgent;
    _undiciFetch = undici.fetch;
} catch { /* undici optional */ }

// ─── Constants ────────────────────────────────────────────────────────────────

// X's public bearer token (hardcoded in their JS bundle, same for all users)
const X_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL query IDs — copy from the actual request URLs in DevTools.
// These are stable for months at a time; update if you start getting 400 errors.
const GQL_QUERY_IDS = {
    UserByScreenName: 'DYkHHnsQHOuIl0gUzU5Fjg',
    UserTweets: 'rO1eqEVXEJOZkbKmVFg5IQ',
};

const MIN_REQUEST_GAP_MS = 500;
const RATE_LIMIT_BASE_MS = 60_000;   // 60s first backoff
const RATE_LIMIT_MAX_MS = 300_000;  // 5 min max
const MAX_RETRIES = 5;
const FETCH_TIMEOUT_MS = 25_000;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── XApiClient ───────────────────────────────────────────────────────────────

export class XApiClient {
    constructor() {
        this._authToken = (process.env.TWITTER_AUTH_TOKEN || '').trim().replace(/^['"]/, '').replace(/['"]$/, '');
        this._ct0 = (process.env.TWITTER_CT0 || '').trim().replace(/^['"]/, '').replace(/['"]$/, '');
        this._proxyServer = process.env.PROXY_SERVER || '';
        this._proxyUsername = process.env.PROXY_USERNAME || '';
        this._proxyPassword = process.env.PROXY_PASSWORD || '';

        this._agent = null;
        this._headers = null;
        this._lastReqTime = 0;

        // Rate-limit state
        this._rateLimitBackoff = RATE_LIMIT_BASE_MS;
        this._consecutiveRateLimits = 0;
        this._isThrottled = false;

        // Cache last fetched profile (avoids a second API round-trip)
        this._lastFetchedProfile = null;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Init / Cleanup
    // ═══════════════════════════════════════════════════════════════════

    initialize() {
        if (!this._authToken) throw new Error('Missing TWITTER_AUTH_TOKEN in environment');
        if (!this._ct0) throw new Error('Missing TWITTER_CT0 in environment');

        // Proxy (optional)
        if (this._proxyServer && _ProxyAgent) {
            const proxyUrl = new URL(this._proxyServer);
            if (this._proxyUsername) proxyUrl.username = encodeURIComponent(this._proxyUsername);
            if (this._proxyPassword) proxyUrl.password = encodeURIComponent(this._proxyPassword);
            this._agent = new _ProxyAgent(proxyUrl.toString());
            console.log(`  🔀 [x-api] Proxy: ${this._proxyServer}`);
        }

        // Build static headers (no browser visit needed)
        this._headers = {
            'Authorization': `Bearer ${decodeURIComponent(X_BEARER_TOKEN)}`,
            'Cookie': `auth_token=${this._authToken}; ct0=${this._ct0}`,
            'X-Csrf-Token': this._ct0,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'X-Twitter-Active-User': 'yes',
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Client-Language': 'en',
            'Referer': 'https://x.com/',
            'Origin': 'https://x.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
        };

        console.log(`  ✅ [x-api] X API client ready (auth_token: ${this._authToken.substring(0, 8)}...)`);
    }

    cleanup() {
        this._agent = null;
        this._headers = null;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Fetch a creator's public profile.
     * @param {string} handle — X screen name (without @)
     * @returns {Promise<object>} profile object
     */
    async fetchCreatorProfile(handle) {
        if (!this._headers) throw new Error('XApiClient not initialized. Call initialize() first.');

        // Return cached profile if we already fetched it as part of fetchCreatorTweets
        if (this._lastFetchedProfile?.username?.toLowerCase() === handle.toLowerCase()) {
            console.log(`  ✅ [x-api] @${handle}: profile from cache`);
            return this._lastFetchedProfile;
        }

        console.log(`  👤 [x-api] @${handle}: fetching profile...`);
        const userResult = await this._gqlRequest('UserByScreenName',
            { screen_name: handle, withGrokTranslatedBio: false },
            this._userByScreenNameFeatures(),
            { withPayments: false, withAuxiliaryUserLabels: true },
        );

        const profile = this._parseProfile(userResult?.data?.user?.result, handle);
        this._lastFetchedProfile = profile;
        console.log(`  ✅ [x-api] @${handle}: ${profile.name} | 👥 ${profile.followersCount} followers`);
        return profile;
    }

    /**
     * Fetch tweets from a creator's profile timeline.
     * @param {string} handle   — X screen name (without @)
     * @param {number} maxTweets — max tweets to return (default 30)
     * @returns {Promise<Array>} array of tweet objects
     */
    async fetchCreatorTweets(handle, maxTweets = 30) {
        if (!this._headers) throw new Error('XApiClient not initialized. Call initialize() first.');

        // Step 1: Resolve screen name → userId
        console.log(`  🔍 [x-api] @${handle}: resolving user ID...`);
        const userResult = await this._gqlRequest('UserByScreenName',
            { screen_name: handle, withGrokTranslatedBio: false },
            this._userByScreenNameFeatures(),
            { withPayments: false, withAuxiliaryUserLabels: true },
        );

        const userObj = userResult?.data?.user?.result;
        const userId = userObj?.rest_id;
        if (!userId) throw new Error(`[x-api] Could not resolve user ID for @${handle}`);

        // Cache profile
        this._lastFetchedProfile = this._parseProfile(userObj, handle);
        console.log(`  📸 [x-api] @${handle}: ${this._lastFetchedProfile.name} | 👥 ${this._lastFetchedProfile.followersCount}`);

        // Step 2: Paginate through UserTweets
        console.log(`  📡 [x-api] @${handle}: fetching tweets (target: ${maxTweets})...`);
        const allTweets = [];
        let cursor = null;
        let pageNum = 0;
        const maxPages = Math.ceil(maxTweets / 15) + 10;

        while (allTweets.length < maxTweets && pageNum < maxPages) {
            pageNum++;

            const variables = {
                userId,
                count: 20,
                includePromotedContent: false,
                withQuickPromoteEligibilityTweetFields: true,
                withVoice: true,
                withV2Timeline: true,
            };
            if (cursor) variables.cursor = cursor;

            let timelineResult;
            try {
                timelineResult = await this._gqlRequest('UserTweets', variables, this._userTweetsFeatures(), this._userTweetsFieldToggles());
            } catch (err) {
                console.log(`  ⚠️ [x-api] @${handle}: page ${pageNum} failed: ${err.message}`);
                break;
            }

            const tweets = this._extractTweets(timelineResult, handle);

            if (tweets.length === 0 && pageNum > 1) {
                console.log(`  📊 [x-api] @${handle}: no more tweets on page ${pageNum}.`);
                break;
            }

            allTweets.push(...tweets);

            cursor = this._extractCursor(timelineResult);
            if (!cursor) {
                console.log(`  📊 [x-api] @${handle}: reached end of timeline.`);
                break;
            }

            const delay = this._isThrottled ? 3000 + Math.random() * 2000 : 500 + Math.random() * 500;
            await sleep(delay);
        }

        const deduped = this._dedup(allTweets);
        deduped.sort((a, b) => new Date(b.timeParsed || 0) - new Date(a.timeParsed || 0));

        console.log(`  ✅ [x-api] @${handle}: ${deduped.length} tweets (${pageNum} pages)`);
        return deduped.slice(0, maxTweets);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Internal: HTTP + retries
    // ═══════════════════════════════════════════════════════════════════

    async _gqlRequest(operationName, variables, features, fieldToggles = null) {
        const queryId = GQL_QUERY_IDS[operationName];
        if (!queryId) throw new Error(`Unknown X operation: ${operationName}`);

        const params = new URLSearchParams({
            variables: JSON.stringify(variables),
            features: JSON.stringify(features),
        });
        if (fieldToggles) params.set('fieldToggles', JSON.stringify(fieldToggles));

        const url = `https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;

        // Enforce minimum gap between requests
        const gap = Date.now() - this._lastReqTime;
        if (gap < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - gap);

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            this._lastReqTime = Date.now();

            const fetchFn = (this._agent && _undiciFetch) ? _undiciFetch : fetch;
            const fetchOpts = {
                method: 'GET',
                headers: this._headers,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            };
            if (this._agent) fetchOpts.dispatcher = this._agent;

            let resp;
            try {
                resp = await fetchFn(url, fetchOpts);
            } catch (err) {
                if (attempt < MAX_RETRIES) {
                    console.log(`  ⏳ [x-api] Network error on ${operationName}, retrying in 5s... (${err.message})`);
                    await sleep(5000);
                    continue;
                }
                throw err;
            }

            if (resp.ok) {
                this._consecutiveRateLimits = 0;
                this._rateLimitBackoff = RATE_LIMIT_BASE_MS;
                this._isThrottled = false;
                return resp.json();
            }

            if (resp.status === 429) {
                this._consecutiveRateLimits++;
                this._isThrottled = true;

                const retryAfter = resp.headers.get('retry-after');
                let waitMs = this._rateLimitBackoff;
                if (retryAfter) {
                    const secs = parseInt(retryAfter, 10);
                    if (!isNaN(secs)) waitMs = secs * 1000;
                }
                waitMs = Math.min(waitMs, RATE_LIMIT_MAX_MS);
                this._rateLimitBackoff = Math.min(this._rateLimitBackoff * 2, RATE_LIMIT_MAX_MS);

                if (attempt < MAX_RETRIES) {
                    console.log(`  ⏳ [x-api] Rate limited (429) on ${operationName}, waiting ${Math.round(waitMs / 1000)}s... (attempt ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }
            }

            if (resp.status >= 500 && attempt < MAX_RETRIES) {
                console.log(`  ⏳ [x-api] Server error (${resp.status}) on ${operationName}, retrying in 5s...`);
                await sleep(5000);
                continue;
            }

            const body = await resp.text().catch(() => '');
            throw new Error(`[x-api] ${operationName} HTTP ${resp.status}: ${body.substring(0, 300)}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Internal: Parsing
    // ═══════════════════════════════════════════════════════════════════

    _parseProfile(userObj, handle) {
        if (!userObj) return { id: null, username: handle, name: handle, bio: '', image: '', followersCount: 0, followingCount: 0, tweetsCount: 0, isVerified: false };

        const legacy = userObj.legacy || {};
        // New API shape has core.name / core.screen_name at top level of user object
        const name = userObj.core?.name || legacy.name || handle;
        const screenName = userObj.core?.screen_name || legacy.screen_name || handle;
        const avatarRaw = userObj.avatar?.image_url || legacy.profile_image_url_https || '';

        return {
            id: userObj.rest_id || null,
            username: screenName,
            name,
            bio: legacy.description || userObj.profile_bio?.description || '',
            image: avatarRaw ? avatarRaw.replace('_normal', '').replace('_200x200', '').replace('_400x400', '') : '',
            followersCount: legacy.followers_count || 0,
            followingCount: legacy.friends_count || 0,
            tweetsCount: legacy.statuses_count || 0,
            isVerified: legacy.verified || userObj.is_blue_verified || false,
        };
    }

    _extractTweets(json, handle) {
        const tweets = [];
        try {
            // X returns timeline under either `timeline` or `timeline_v2` depending on the account
            const instructions =
                json?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
                json?.data?.user?.result?.timeline?.timeline?.instructions ||
                [];

            for (const instruction of instructions) {
                const entries = instruction?.entries || [];

                for (const entry of entries) {
                    // Direct single tweet entry (TimelineTimelineItem)
                    const directResult = entry?.content?.itemContent?.tweet_results?.result;
                    if (directResult) {
                        const tweet = this._parseTweet(directResult, handle);
                        if (tweet) tweets.push(tweet);
                        continue;
                    }

                    // Conversation / thread module (TimelineTimelineModule)
                    const items = entry?.content?.items || [];
                    if (items.length > 0) {
                        const threadTweets = [];
                        for (const item of items) {
                            const itemResult = item?.item?.itemContent?.tweet_results?.result;
                            if (itemResult) {
                                const tweet = this._parseTweet(itemResult, handle);
                                if (tweet) threadTweets.push(tweet);
                            }
                        }
                        if (threadTweets.length > 0) {
                            const first = threadTweets[0];
                            if (threadTweets.length > 1) {
                                // Stitch thread into one post
                                first.text = threadTweets.map(t => t.text).join('\n\n---\n\n');
                                first.media = [...new Map(threadTweets.flatMap(t => t.media || []).map(m => [m.url, m])).values()];
                            }
                            tweets.push(first);
                        }
                    }
                }
            }
        } catch { /* partial parse is fine */ }
        return tweets;
    }

    _parseTweet(result, handle) {
        try {
            // Handle TweetWithVisibilityResults wrapper
            const tweetData = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
            const legacy = tweetData?.legacy;
            if (!legacy) return null;

            const text = legacy.full_text || '';

            // Skip retweets
            if (text.startsWith('RT @')) return null;

            // Skip tweets with only whitespace/URLs and no media
            const textWithoutUrls = text.replace(/https?:\/\/\S+/g, '').trim();
            if (!textWithoutUrls && !legacy.extended_entities?.media?.length) return null;

            // Skip replies to other users (keep self-replies / threads)
            const isReply = !!legacy.in_reply_to_status_id_str;
            const replyToUser = legacy.in_reply_to_screen_name?.toLowerCase();
            const isSelfReply = replyToUser === handle?.toLowerCase();
            if (isReply && !isSelfReply) return null;

            // Media extraction
            const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
            const media = mediaEntities.map(m => {
                if (m.type === 'video' || m.type === 'animated_gif') {
                    const mp4s = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
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

            const viewCount = tweetData?.views?.count ? parseInt(tweetData.views.count, 10) : 0;

            return {
                id: legacy.id_str || tweetData.rest_id,
                text,
                timeParsed: legacy.created_at ? new Date(legacy.created_at) : null,
                timestamp: legacy.created_at ? Math.floor(new Date(legacy.created_at).getTime() / 1000) : null,
                likes: legacy.favorite_count || 0,
                retweets: legacy.retweet_count || 0,
                replies: legacy.reply_count || 0,
                quotes: legacy.quote_count || 0,
                bookmarkCount: legacy.bookmark_count || 0,
                views: viewCount,
                conversationId: legacy.conversation_id_str || null,
                inReplyToStatusId: legacy.in_reply_to_status_id_str || null,
                isRetweet: false,
                isReply,
                isSelfReply,
                username: handle,
                userId: legacy.user_id_str || null,
                hashtags: (legacy.entities?.hashtags || []).map(h => h.text),
                urls: (legacy.entities?.urls || []).map(u => u.expanded_url),
                media: media.length > 0 ? media : null,
            };
        } catch { return null; }
    }

    _extractCursor(json) {
        try {
            const instructions =
                json?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
                json?.data?.user?.result?.timeline?.timeline?.instructions ||
                [];
            for (const instruction of instructions) {
                for (const entry of (instruction?.entries || [])) {
                    if (entry?.entryId?.startsWith('cursor-bottom')) {
                        return entry?.content?.value || null;
                    }
                }
                // TimelineReplaceEntry cursor
                if (instruction?.type === 'TimelineReplaceEntry') {
                    const entry = instruction?.entry;
                    if (entry?.entryId?.startsWith('cursor-bottom')) {
                        return entry?.content?.value || null;
                    }
                }
            }
        } catch { }
        return null;
    }

    _dedup(tweets) {
        const seen = new Set();
        return tweets.filter(t => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Internal: Feature flags (copy from browser request as of Mar 2026)
    // ═══════════════════════════════════════════════════════════════════

    _userByScreenNameFeatures() {
        return {
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
        };
    }

    _userTweetsFeatures() {
        return {
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
        };
    }

    _userTweetsFieldToggles() {
        return {
            withPayments: false,
            withAuxiliaryUserLabels: true,
            withArticleRichContentState: true,
            withArticlePlainText: false,
            withGrokAnalyze: false,
            withDisallowedReplyControls: false,
        };
    }
}
