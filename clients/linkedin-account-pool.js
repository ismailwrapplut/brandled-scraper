/**
 * LinkedIn Account Pool
 *
 * Manages multiple LinkedIn account + proxy pairs for robust scraping.
 * Each proxy is permanently paired with exactly one LinkedIn account.
 *
 * Features:
 *   - Round-robin rotation across healthy pairs
 *   - Auto-blacklist on auth/restriction errors (with cooldown)
 *   - Fallback to next healthy pair when one fails
 *   - Backward-compatible with single-account .env setup
 *
 * .env format (add as many as needed):
 *   LINKEDIN_POOL_1_LI_AT=<cookie>
 *   LINKEDIN_POOL_1_JSESSIONID=<jsessionid>
 *   LINKEDIN_POOL_1_PROXY_SERVER=http://proxy:port
 *   LINKEDIN_POOL_1_PROXY_USERNAME=<user>
 *   LINKEDIN_POOL_1_PROXY_PASSWORD=<pass>
 */

// How long a blacklisted pair stays out of rotation (default 30 min)
const BLACKLIST_COOLDOWN_MS = 30 * 60 * 1000;

// How many consecutive failures before blacklisting
const MAX_CONSECUTIVE_FAILURES = 2;

export class LinkedInAccountPool {
    constructor() {
        /** @type {AccountPair[]} */
        this.pairs = [];

        /** Index for round-robin */
        this._nextIndex = 0;
    }

    // ───────────────────────────────────────────────────────────────────
    //  Initialisation — reads from process.env
    // ───────────────────────────────────────────────────────────────────

    load() {
        this.pairs = [];

        // Discover numbered pool entries: LINKEDIN_POOL_<N>_LI_AT
        const poolIndices = new Set();
        for (const key of Object.keys(process.env)) {
            const m = key.match(/^LINKEDIN_POOL_(\d+)_LI_AT$/);
            if (m) poolIndices.add(Number(m[1]));
        }

        // Sort numerically so ordering is predictable
        const sorted = [...poolIndices].sort((a, b) => a - b);

        for (const n of sorted) {
            const prefix = `LINKEDIN_POOL_${n}`;
            const liAt = process.env[`${prefix}_LI_AT`]?.trim();
            if (!liAt) continue;

            this.pairs.push({
                id: n,
                label: `pool-${n}`,
                liAt,
                jsessionId: process.env[`${prefix}_JSESSIONID`]?.replace(/"/g, "").trim() || "",
                proxyServer: process.env[`${prefix}_PROXY_SERVER`]?.trim() || "",
                proxyUsername: process.env[`${prefix}_PROXY_USERNAME`]?.trim() || "",
                proxyPassword: process.env[`${prefix}_PROXY_PASSWORD`]?.trim() || "",

                // Health tracking
                healthy: true,
                consecutiveFailures: 0,
                blacklistedUntil: 0,
                totalRequests: 0,
                totalFailures: 0,
                lastUsed: 0,
                lastError: "",
            });
        }

        // Backward-compat: if pool is empty, fall back to single-account env vars
        if (this.pairs.length === 0 && process.env.LINKEDIN_LI_AT_COOKIE) {
            this.pairs.push({
                id: 0,
                label: "legacy",
                liAt: process.env.LINKEDIN_LI_AT_COOKIE.trim(),
                jsessionId: process.env.LINKEDIN_JSESSIONID?.replace(/"/g, "").trim() || "",
                proxyServer: process.env.PROXY_SERVER?.trim() || "",
                proxyUsername: process.env.PROXY_USERNAME?.trim() || "",
                proxyPassword: process.env.PROXY_PASSWORD?.trim() || "",

                healthy: true,
                consecutiveFailures: 0,
                blacklistedUntil: 0,
                totalRequests: 0,
                totalFailures: 0,
                lastUsed: 0,
                lastError: "",
            });
        }

        console.log(`📦 LinkedIn account pool loaded: ${this.pairs.length} pair(s)`);
        for (const p of this.pairs) {
            const proxy = p.proxyServer ? p.proxyServer : "no-proxy";
            console.log(`   [${p.label}] li_at=…${p.liAt.slice(-8)}  proxy=${proxy}`);
        }

        return this;
    }

    // ───────────────────────────────────────────────────────────────────
    //  Getters
    // ───────────────────────────────────────────────────────────────────

    get size() {
        return this.pairs.length;
    }

    get healthyCount() {
        this._refreshBlacklist();
        return this.pairs.filter((p) => p.healthy).length;
    }

    /** Returns true if there is at least one usable pair */
    get hasAvailable() {
        return this.healthyCount > 0;
    }

    // ───────────────────────────────────────────────────────────────────
    //  Rotation
    // ───────────────────────────────────────────────────────────────────

    /**
     * Get the next healthy account pair (round-robin).
     * Skips blacklisted pairs. Returns null if none available.
     * @returns {AccountPair | null}
     */
    next() {
        this._refreshBlacklist();

        const healthy = this.pairs.filter((p) => p.healthy);
        if (healthy.length === 0) return null;

        // Round-robin index within healthy subset
        const idx = this._nextIndex % healthy.length;
        this._nextIndex = (this._nextIndex + 1) % healthy.length;

        const pair = healthy[idx];
        pair.totalRequests++;
        pair.lastUsed = Date.now();
        return pair;
    }

    /**
     * Get all healthy pairs (for fallback iteration).
     * Orders them so the "next" pair is first.
     * @returns {AccountPair[]}
     */
    allHealthy() {
        this._refreshBlacklist();
        const healthy = this.pairs.filter((p) => p.healthy);

        if (healthy.length === 0) return [];

        // Rotate array so the "next" pair is first
        const idx = this._nextIndex % healthy.length;
        return [...healthy.slice(idx), ...healthy.slice(0, idx)];
    }

    // ───────────────────────────────────────────────────────────────────
    //  Health reporting
    // ───────────────────────────────────────────────────────────────────

    /**
     * Report a successful scrape for a pair.
     */
    reportSuccess(pair) {
        pair.consecutiveFailures = 0;
        pair.healthy = true;
    }

    /**
     * Report a failure for a pair. Auto-blacklists after MAX_CONSECUTIVE_FAILURES.
     * @param {AccountPair} pair
     * @param {string} errorMessage
     * @param {boolean} [isFatal=false] - If true, blacklist immediately (e.g. auth error)
     */
    reportFailure(pair, errorMessage, isFatal = false) {
        pair.totalFailures++;
        pair.consecutiveFailures++;
        pair.lastError = errorMessage;

        const isAuthError =
            isFatal ||
            errorMessage.includes("login") ||
            errorMessage.includes("authwall") ||
            errorMessage.includes("restricted") ||
            errorMessage.includes("cookie invalid") ||
            errorMessage.includes("cookie expired") ||
            errorMessage.includes("CHALLENGE") ||
            errorMessage.includes("403");

        if (isAuthError || pair.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            pair.healthy = false;
            pair.blacklistedUntil = Date.now() + BLACKLIST_COOLDOWN_MS;
            console.log(
                `  🚫 [${pair.label}] blacklisted for ${BLACKLIST_COOLDOWN_MS / 60000}min — ` +
                `reason: ${isAuthError ? "auth/restriction error" : `${pair.consecutiveFailures} consecutive failures`} ` +
                `(${errorMessage.substring(0, 80)})`
            );
        }
    }

    /**
     * Immediately blacklist a pair (e.g. account got restricted).
     * @param {AccountPair} pair
     * @param {number} [durationMs] - Override cooldown duration
     */
    blacklist(pair, durationMs = BLACKLIST_COOLDOWN_MS) {
        pair.healthy = false;
        pair.blacklistedUntil = Date.now() + durationMs;
        console.log(`  🚫 [${pair.label}] manually blacklisted for ${durationMs / 60000}min`);
    }

    // ───────────────────────────────────────────────────────────────────
    //  Diagnostics
    // ───────────────────────────────────────────────────────────────────

    /**
     * Print a summary table of pool health.
     */
    printStatus() {
        this._refreshBlacklist();
        console.log("\n📊 LinkedIn Account Pool Status:");
        console.log("─".repeat(70));
        for (const p of this.pairs) {
            const status = p.healthy ? "✅ healthy" : `❌ blacklisted (until ${new Date(p.blacklistedUntil).toLocaleTimeString()})`;
            const stats = `reqs=${p.totalRequests} fails=${p.totalFailures} consecutiveFails=${p.consecutiveFailures}`;
            console.log(`  [${p.label}] ${status}  ${stats}`);
            if (p.lastError) console.log(`           last error: ${p.lastError.substring(0, 100)}`);
        }
        console.log("─".repeat(70));
    }

    // ───────────────────────────────────────────────────────────────────
    //  Internals
    // ───────────────────────────────────────────────────────────────────

    /**
     * Unblacklist pairs whose cooldown has expired.
     */
    _refreshBlacklist() {
        const now = Date.now();
        for (const p of this.pairs) {
            if (!p.healthy && p.blacklistedUntil > 0 && now >= p.blacklistedUntil) {
                p.healthy = true;
                p.consecutiveFailures = 0;
                p.blacklistedUntil = 0;
                console.log(`  ♻️  [${p.label}] cooldown expired — re-enabled`);
            }
        }
    }
}

/**
 * @typedef {Object} AccountPair
 * @property {number} id
 * @property {string} label
 * @property {string} liAt
 * @property {string} jsessionId
 * @property {string} proxyServer
 * @property {string} proxyUsername
 * @property {string} proxyPassword
 * @property {boolean} healthy
 * @property {number} consecutiveFailures
 * @property {number} blacklistedUntil
 * @property {number} totalRequests
 * @property {number} totalFailures
 * @property {number} lastUsed
 * @property {string} lastError
 */
