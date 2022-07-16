import dotenv from 'dotenv';
import {TwitterApi, ApiResponseError} from 'twitter-api-v2';
import {WebhookClient} from 'discord.js';
import sqlite3 from 'better-sqlite3';

dotenv.config();

const twitter = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
const client = new WebhookClient({url: process.env.WEBHOOK_URL});
const db = sqlite3(process.env.DB_FILE ?? 'data.db');
const webhookId = client.id;

const RATE_LIMIT = 1500;
const RATE_LIMIT_WINDOW = 15 * 60;

const MONTHLY_RATE_LIMIT = 500000;
const MONTHLY_RATE_LIMIT_WINDOW = 60 * 60 * 24 * 30;

// Set up database schema
db.exec(`
    CREATE TABLE IF NOT EXISTS latest (
        webhook_id TEXT NOT NULL,
        twitter_id TEXT NOT NULL,
        latest_tweet_id TEXT NOT NULL,
        PRIMARY KEY (webhook_id, twitter_id)
    )
`);

const statements = {
    updateLatest: (() => {
        const updateLatestStmt = db.prepare(`INSERT INTO latest VALUES (
            @webhook_id,
            @twitter_id,
            @latest_tweet_id
        ) ON CONFLICT(webhook_id, twitter_id) DO UPDATE SET
            webhook_id=excluded.webhook_id,
            twitter_id=excluded.twitter_id,
            latest_tweet_id=@latest_tweet_id`);
        return db.transaction(items => {
            for (const {webhookId, twitterId, latestId} of items) {
                updateLatestStmt.run({webhook_id: webhookId, twitter_id: twitterId, latest_tweet_id: latestId});
            };
        });
    })(),
    getLatest: db.prepare(`SELECT latest_tweet_id FROM latest WHERE webhook_id = @webhookId AND twitter_id = @twitterId`)
};

const pollingRate = Number(process.env.POLLING_RATE);
if (!Number.isFinite(pollingRate)) {
    throw new Error('Polling rate unspecified');
}

const ACCOUNTS = process.env.ACCOUNTS?.split(/\s*,\s*/);
if (!ACCOUNTS || !ACCOUNTS.length) {
    throw new Error('No accounts specified');
}

// Number of times the poll function will be called per ratelimit window
const execsPerWindow = RATE_LIMIT_WINDOW / pollingRate;
// Number of API endpoint requests per ratelimit window
const fetchesPerWindow = execsPerWindow * ACCOUNTS.length;

const execsPerMonthlyWindow = MONTHLY_RATE_LIMIT_WINDOW / pollingRate;
const fetchesPerMonthlyWindow = execsPerMonthlyWindow * ACCOUNTS.length * 10;

console.log(`Watching accounts ${ACCOUNTS.join(', ')}`);
console.log(`${fetchesPerWindow} API requests per ratelimit window (maximum is ${RATE_LIMIT})`);
console.log(`${fetchesPerMonthlyWindow} API requests per monthly ratelimit window (maximum is ${MONTHLY_RATE_LIMIT})`);
if (fetchesPerWindow > RATE_LIMIT || fetchesPerMonthlyWindow > MONTHLY_RATE_LIMIT) {
    throw new Error('API request rate exceeds rate limit');
}

const fetchedUsers = (await twitter.v2.usersByUsernames(ACCOUNTS, {'user.fields': ['profile_image_url', 'description', 'protected']})).data;

const fetchTweets = async () => {
    try {
        const latestUpdates = [];
        const newTweets = [];
        for (const user of fetchedUsers) {
            const {id} = user;
            const latestResult = statements.getLatest.get({webhookId, twitterId: id});
            const latest = latestResult?.latest_tweet_id;
            const {tweets} = await twitter.v2.userTimeline(id, {
                exclude: ['retweets', 'replies'],
                'user.fields': ['name'],
                since_id: latest
            });
            // No tweets :(
            if (!tweets.length) continue;
            latestUpdates.push({webhookId, twitterId: id, latestId: tweets[0].id});

            // Our first time running
            if (!latest) continue;

            let i = 0;
            for (; i < tweets.length; i++) {
                if (tweets[i].id <= latest) break;
                newTweets.push({tweet: tweets[i], user});
            }

            if (i > 0) console.log(`${i} new tweets from @${user.username}`);

            if (tweets.length >= 10) {
                await client.send({
                    content: 'Too many tweets! Displaying 10 most recent.',
                    username: user.name,
                    avatarURL: user.profile_image_url
                });
            }
        }
        // Sort by ID/timestamp
        newTweets.sort((a, b) => a.tweet.id > b.tweet.id ? 1 : -1);

        for (const {tweet, user} of newTweets) {
            await client.send({
                content: `https://twitter.com/${user.username}/status/${tweet.id}`,
                username: user.name,
                avatarURL: user.profile_image_url
            });
        }

        // we did it reddit
        statements.updateLatest(latestUpdates);
    } catch (err) {
        if ((err instanceof ApiResponseError) && err.code === 503) {
            // Twitter is down. Just wait for it to come back online.
            return;
        }
        throw err;
    }
};

setInterval(fetchTweets, pollingRate * 1000);
fetchTweets();
