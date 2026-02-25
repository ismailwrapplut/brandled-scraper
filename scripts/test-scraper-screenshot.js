import { LinkedInClient } from "../clients/linkedin-client.js";

async function run() {
    const liClient = new LinkedInClient();
    try {
        await liClient.initialize();
        const profileUrl = `https://www.linkedin.com/in/whyismail`;
        await liClient.context.newPage().then(async (page) => {
            await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(5000); // 5s wait
            await page.screenshot({ path: "linkedin-debug.png" });
            const html = await page.content();
            const fs = await import("fs");
            fs.writeFileSync("linkedin-debug.html", html);
            console.log("Saved screenshot and HTML to brandled-scraper/linkedin-debug.png");
        });
    } catch (e) {
        console.log("Error:", e);
    } finally {
        await liClient.cleanup();
    }
}
run();
