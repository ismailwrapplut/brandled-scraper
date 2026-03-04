import { MongoClient } from "mongodb";

// Cache the client so it's only created once per process
let _client = null;

export async function getMongoClient() {
    if (_client) return _client;

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is missing in .env");
    }

    _client = new MongoClient(uri);
    await _client.connect();
    console.log("🍃 MongoDB connected successfully");

    return _client;
}

/**
 * Upsert seed data into MongoDB
 * @param {Array} posts - Array of normalized/embedded post objects
 */
export async function upsertToMongoDB(posts) {
    if (!posts || posts.length === 0) return;

    try {
        const client = await getMongoClient();
        // The user requested saving in the "test" database, in a new collection (e.g., "seeded_posts")
        const db = client.db("test");
        const collection = db.collection("seeded_posts");

        // Format posts for MongoDB
        const ops = posts.map(post => {
            // Remove vector field if it's too large, but vectors are usually pushed to Pinecone.
            // For MongoDB, we store the full raw/normalized payload minus vector if we want, or keep it.
            return {
                updateOne: {
                    filter: { id: post.id },
                    update: { $set: post },
                    upsert: true
                }
            };
        });

        const result = await collection.bulkWrite(ops, { ordered: false });
        console.log(`  🍃 MongoDB Upsert: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
    } catch (error) {
        console.error("  ❌ [MongoDB] Error upserting to MongoDB:", error);
        throw error; // Re-throw if critical, or just let it log
    }
}
