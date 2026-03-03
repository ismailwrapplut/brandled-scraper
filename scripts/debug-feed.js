import('dotenv/config').then(async () => {
    const { LinkedInApiClient } = await import('./clients/linkedin-api-client.js');
    const { LinkedInAccountPool } = await import('./clients/linkedin-account-pool.js');
    const pool = new LinkedInAccountPool();
    pool.load();
    const pair = pool.next();

    // We assume the pool has accounts loaded.
    const client = new LinkedInApiClient(pair);
    client.initialize();

    console.log('Fetching posts...');
    const profileUrn = 'urn:li:fsd_profile:ACoAABt7kPUB7XpcJQyCwbVtHSEd6vBD5Cg3nyg';
    const variables = '(count:5,start:0,profileUrn:' + encodeURIComponent(profileUrn) + ')';
    const feedUrl =
        'https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true' +
        '&variables=' + variables +
        '&queryId=voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822';

    const feedResp = await client._apiGet(feedUrl);

    const fs = await import('fs');
    fs.writeFileSync('/tmp/linkedin-feed-response.json', JSON.stringify(feedResp.data, null, 2));
    console.log('Saved to /tmp/linkedin-feed-response.json');

    client.cleanup();
});
