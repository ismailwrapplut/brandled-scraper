import { XClient } from "../clients/x-client.js";

async function run() {
    const xClient = new XClient();
    try {
        await xClient.initialize();
        const handle = "iamismail";

        let foundImage = null;
        xClient.context.on("page", page => {
            page.on("response", async (res) => {
                if (res.url().includes("/UserByScreenName")) {
                    const json = await res.json();
                    const legacy = json?.data?.user?.result?.legacy;
                    foundImage = legacy?.profile_image_url_https;
                    console.log("X legacy object keys:", legacy ? Object.keys(legacy) : "none");
                    console.log("RAW IMAGE URL:", foundImage);
                }
            });
        });

        const profile = await xClient.fetchCreatorProfile(handle);
        console.log("X Profile Result:", profile, "Found image inside event:", foundImage);
    } catch (e) {
        console.log(e);
    } finally {
        await xClient.cleanup();
    }
}
run();
