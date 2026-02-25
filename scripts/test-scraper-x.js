import { XClient } from "../clients/x-client.js";

async function run() {
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
