import dotenv from 'dotenv';
import {TwitterApi, ApiResponseError, UserV2} from 'twitter-api-v2';
import {WebhookClient} from 'discord.js';
import sqlite3 from 'better-sqlite3';

dotenv.config();

function orError<T> (value: T | undefined, message: string): T {
    if (typeof value === 'undefined') throw new Error(message);
    return value;
}

function orDefault<T> (
    value: T | undefined,
    defaultValue: T): T {
    return (typeof value === 'undefined') ? defaultValue : value;
}

function expectNumber (value: string | undefined): number | undefined {
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue))  return parsedValue;
    return undefined;
}

const config = {
    bearerToken: orError(process.env.TWITTER_BEARER_TOKEN, 'Expected bearer token'),
    webhookUrl: orError(process.env.WEBHOOK_URL, 'Expected webhook URL'),
    dbFile: orDefault(process.env.DB_FILE, 'data.db'),
    maxTweetsAtOnce: orDefault(expectNumber(process.env.MAX_TWEETS_AT_ONCE), 10),
    pollingRate: orError(expectNumber(process.env.POLLING_RATE), 'Expected polling rate'),
    accounts: orError(((v: string | undefined): string[] | undefined => {
        if (!v) return undefined;
        const arr = v.split(/\s*,\s*/);
        if (!arr.length) return undefined;
        return arr;
    })(process.env.ACCOUNTS), 'Expected accounts list')
};

const twitter = new TwitterApi(config.bearerToken);
const client = new WebhookClient({url: config.webhookUrl});
const db = sqlite3(config.dbFile);
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

type UpdateLatest = {
    webhook_id: string,
    twitter_id: string,
    latest_tweet_id: string
};

const statements = {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    updateLatest: (() => {
        const updateLatestStmt = db.prepare<UpdateLatest>(`INSERT INTO latest VALUES (
            @webhook_id,
            @twitter_id,
            @latest_tweet_id
        ) ON CONFLICT(webhook_id, twitter_id) DO UPDATE SET
            webhook_id=excluded.webhook_id,
            twitter_id=excluded.twitter_id,
            latest_tweet_id=@latest_tweet_id`);
        return db.transaction((items: UpdateLatest[]) => {
            for (const item of items) {
                updateLatestStmt.run(item);
            }
        });
    })(),
    getLatest: db.prepare(`SELECT latest_tweet_id FROM latest WHERE webhook_id = @webhookId AND twitter_id = @twitterId`)
};

// Number of times the poll function will be called per ratelimit window
const execsPerWindow = RATE_LIMIT_WINDOW / config.pollingRate;
// Number of API endpoint requests per ratelimit window
const fetchesPerWindow = execsPerWindow * config.accounts.length;

const execsPerMonthlyWindow = MONTHLY_RATE_LIMIT_WINDOW / config.pollingRate;
const fetchesPerMonthlyWindow = execsPerMonthlyWindow * config.accounts.length * 10;

console.log(`Watching accounts ${config.accounts.join(', ')}`);
console.log(`${fetchesPerWindow} API requests per ratelimit window (maximum is ${RATE_LIMIT})`);
console.log(`${fetchesPerMonthlyWindow} API requests per monthly ratelimit window (maximum is ${MONTHLY_RATE_LIMIT})`);
if (fetchesPerWindow > RATE_LIMIT || fetchesPerMonthlyWindow > MONTHLY_RATE_LIMIT) {
    throw new Error('API request rate exceeds rate limit');
}

const fetchTweets = async (users: UserV2[]): Promise<void> => {
    try {
        const latestUpdates: UpdateLatest[] = [];
        const newTweets = [];
        for (const user of users) {
            const {id} = user;
            const latestResult = statements.getLatest.get({
                webhookId, twitterId: id}) as {latest_tweet_id: string} | undefined;
            const latest = latestResult?.latest_tweet_id;
            const {tweets} = await twitter.v2.userTimeline(id, {
                exclude: ['retweets', 'replies'],
                'user.fields': ['name'],
                since_id: latest,
                max_results: config.maxTweetsAtOnce
            });
            // No tweets :(
            if (!tweets.length) continue;
            latestUpdates.push({webhook_id: webhookId, twitter_id: id, latest_tweet_id: tweets[0].id});

            // Our first time running
            if (!latest) continue;

            let i = 0;
            for (; i < tweets.length; i++) {
                if (tweets[i].id <= latest) break;
                newTweets.push({tweet: tweets[i], user});
            }

            if (i > 0) console.log(`${i} new tweets from @${user.username}`);

            if (tweets.length >= config.maxTweetsAtOnce) {
                await client.send({
                    content: `Too many tweets! Displaying ${config.maxTweetsAtOnce} most recent.`,
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

const main = async (): Promise<void> => {
    const users = (await twitter.v2.usersByUsernames(
        config.accounts, {'user.fields': ['profile_image_url', 'description', 'protected']})).data;
    setInterval(() => void fetchTweets(users), config.pollingRate * 1000);
    void fetchTweets(users);
};

void main();
