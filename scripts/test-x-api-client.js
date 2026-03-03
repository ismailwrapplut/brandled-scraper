/**
 * Quick test for the new XApiClient (pure HTTP, no browser).
 * 
 * Run on the droplet:
 *   cd /home/scraper/brandled-scraper
 *   sudo -u scraper git pull
 *   sudo -u scraper node scripts/test-x-api-client.js theHandle
 * 
 * Or test locally (Windows):
 *   node scripts/test-x-api-client.js thejustinwelsh
 */

import 'dotenv/config';
import { XApiClient } from '../clients/x-api-client.js';

const handle = process.argv[2] || 'thejustinwelsh';
const maxTweets = parseInt(process.argv[3] || '5', 10);

const client = new XApiClient();
client.initialize();

console.log(`\n🐦 Testing XApiClient for @${handle} (${maxTweets} tweets)\n`);

const profile = await client.fetchCreatorProfile(handle);
console.log('\n📋 Profile:');
console.log(JSON.stringify(profile, null, 2));

const tweets = await client.fetchCreatorTweets(handle, maxTweets);
console.log(`\n📝 Tweets (${tweets.length}):`);
console.log(JSON.stringify(tweets, null, 2));

client.cleanup();
