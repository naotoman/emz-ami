import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { BrowserContext, chromium, Page } from "playwright";
import { myLog } from "./myUtils";
import { Merc, Mshop, scrapeMerc, scrapeMshop, ScrapeResult } from "./scraper";
import { randomUserAgent } from "./useragent";

interface User {
  username: string;
}

interface Item {
  orgPlatform: string;
  orgUrl: string;
  ebaySku: string;
}

interface AppParams {
  r2Domain: string;
  r2Endpoint: string;
  r2Bucket: string;
  r2Prefix: string;
  r2KeySsmParamName: string;
}

interface Body {
  item: Item;
  user: User;
  appParams: AppParams;
}

const sqsClient = new SQSClient({
  region: "ap-northeast-1",
});
const queueUrl = process.env.QUEUE_URL;

const playMerc = async (page: Page): Promise<ScrapeResult<Merc>> => {
  const failureLocator = page.locator("div.merEmptyState");
  const priceLocator = page.locator('#item-info div[data-testid="price"]');
  const imageLocator = page.locator('article div[data-testid="image-0"] img');
  const userLocator = page.locator("div.merUserObject");
  await failureLocator.or(priceLocator).waitFor({ timeout: 16000 });
  await failureLocator.or(imageLocator).waitFor({ timeout: 16000 });
  await failureLocator.or(userLocator).waitFor({ timeout: 16000 });

  page.on("console", (msg) => console.log(msg.text()));
  const scrapeResult = await page.evaluate(scrapeMerc);
  return scrapeResult;
};

const playMshop = async (page: Page): Promise<ScrapeResult<Mshop>> => {
  const failureLocator = page.locator("div.merEmptyState");
  const priceLocator = page.locator(
    '#product-info div[data-testid="product-price"]'
  );
  const imageLocator = page.locator('article div[data-testid="image-0"] img');
  const userLocator = page.locator("div.merUserObject");
  await failureLocator.or(priceLocator).waitFor({ timeout: 16000 });
  await failureLocator.or(imageLocator).waitFor({ timeout: 16000 });
  await failureLocator.or(userLocator).waitFor({ timeout: 16000 });

  page.on("console", (msg) => console.log(msg.text()));
  const scrapeResult = await page.evaluate(scrapeMshop);
  return scrapeResult;
};

async function pollMessage(context: BrowserContext) {
  console.log("polling");
  const receiveCommand = new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 3,
  });
  const response = await sqsClient.send(receiveCommand);

  if (!response.Messages || response.Messages.length === 0) {
    console.log("No messages received");
    return;
  }

  const message = response.Messages[0];
  console.log("Received message:", message?.Body);
  if (!message?.Body) {
    console.error("Message body is empty");
    return;
  }

  const body: Body = JSON.parse(message.Body);
  myLog(body);

  // メッセージを正常に処理したら削除
  const deleteCommand = new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: message.ReceiptHandle,
  });
  await sqsClient.send(deleteCommand);
}

// ポーリングを開始
async function startPolling() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
  });

  while (true) {
    const start = Date.now();
    try {
      await pollMessage(context);
    } catch (error) {
      console.error("Polling error:", error);
    }
    const elapsed = Date.now() - start;
    if (elapsed < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 5000 - elapsed));
    }
  }
}

startPolling().catch((error) => {
  console.error("Polling error:", error);
});
