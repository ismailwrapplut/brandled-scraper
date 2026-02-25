// Test LinkedIn cookie validity
import "dotenv/config";
import { chromium } from "playwright";

const liAt = process.env.LINKEDIN_LI_AT_COOKIE;

if (!liAt) {
    console.log("❌ No LINKEDIN_LI_AT_COOKIE set in .env");
    process.exit(1);
}

console.log("Cookie length:", liAt.length);
console.log("Starts with:", liAt.slice(0, 15) + "...");
console.log("Ends with: ..." + liAt.slice(-15));

// Check for common issues
if (liAt.includes('"') || liAt.includes("'")) {
    console.log("⚠️  Cookie contains quotes — remove them from .env");
}
if (liAt.startsWith(" ") || liAt.endsWith(" ")) {
    console.log("⚠️  Cookie has leading/trailing spaces — remove them from .env");
}

const b = await chromium.launch({ headless: true });
const c = await b.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
});

await c.addCookies([{
    name: "li_at",
    value: liAt.trim().replace(/^["']|["']$/g, ""),
    domain: ".linkedin.com",
    path: "/",
    httpOnly: true,
    secure: true,
}]);

const p = await c.newPage();

console.log("\nTest 1: Navigating to linkedin.com/feed/ ...");
try {
    await p.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
    });
    const url = p.url();
    console.log("  URL:", url);

    if (url.includes("/login") || url.includes("/authwall")) {
        console.log("  ❌ COOKIE INVALID — redirected to login");
        console.log("\n  To fix: Open LinkedIn in Chrome, go to DevTools → Application → Cookies");
        console.log("  Copy the full li_at value and paste into .env (no quotes)");
    } else if (url.includes("/feed")) {
        console.log("  ✅ COOKIE VALID — feed loaded successfully!");

        console.log("\nTest 2: Navigating to activity page...");
        await p.goto("https://www.linkedin.com/in/justinwelsh/recent-activity/all/", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });
        const url2 = p.url();
        console.log("  URL:", url2);

        if (url2.includes("recent-activity")) {
            console.log("  ✅ Activity page accessible!");
            await p.waitForTimeout(3000);
            const title = await p.title();
            console.log("  Title:", title);
        } else {
            console.log("  ⚠️  Redirected:", url2);
        }
    } else {
        console.log("  ⚠️  Unexpected URL:", url);
    }
} catch (e) {
    console.log("  ❌ Error:", e.message.slice(0, 200));

    if (e.message.includes("ERR_TOO_MANY_REDIRECTS")) {
        console.log("\n  The cookie is causing a redirect loop. Possible causes:");
        console.log("  1. Cookie was copied with extra quotes or whitespace");
        console.log("  2. Account session was invalidated (password changed, 2FA)");
        console.log("  3. Account was temporarily restricted");
        console.log("\n  Fix: Log into LinkedIn in Chrome, then re-copy the li_at cookie.");
    }
}

await b.close();
