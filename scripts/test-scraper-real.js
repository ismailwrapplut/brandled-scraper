import { LinkedInClient } from "../clients/linkedin-client.js";
import { XClient } from "../clients/x-client.js";

async function run() {
    console.log("Testing LinkedIn...");
    const liClient = new LinkedInClient();
    try {
        await liClient.initialize();
        const profileUrl = `https://www.linkedin.com/in/whyismail`;
        const profile = await liClient.fetchCreatorProfile(profileUrl);
        console.log("LI Profile:", profile);
        const posts = await liClient.fetchCreatorPosts(profileUrl, 5);
        console.log(`LI Posts: ${posts.length}`);
    } catch (e) {
        console.log("LI Error:", e);
    } finally {
        await liClient.cleanup();
    }

    console.log("\nTesting X...");
    const xClient = new XClient();
    try {
        await xClient.initialize();
        const handle = "iamismail";
        const profile = await xClient.fetchCreatorProfile(handle);
        console.log("X Profile:", profile);
        const tweets = await xClient.fetchCreatorTweets(handle, 5);
        console.log(`X Tweets: ${tweets.length}`);
    } catch (e) {
        console.log("X Error:", e);
    } finally {
        await xClient.cleanup();
    }
}
run();
