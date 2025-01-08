import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { BrowserContext, chromium } from "playwright";
import * as ddb from "./dynamodbUtils";
import { listItem, retrieveItem } from "./listing";
import { runPlaywright } from "./playwright-scraper";
import { Merc, Mshop, ScrapeResult } from "./scraper";
import { randomUserAgent } from "./useragent";

interface User {
  username: string;
  sellerBlacklist: string[];
  returnPolicy: string;
  paymentPolicy: string;
  profitRatio: number;
  merchantLocationKey: string;
}

interface Item {
  id: string;
  orgPlatform: string;
  orgUrl: string;
  ebaySku: string;
  isOrgLive: boolean;
  isImageChanged: boolean;
  isListed: boolean;
  orgImageUrls: string[];
  orgPrice: number;
  orgTitle: string;
  shippingYen: number;
  ebayTitle: string;
  ebayDescription: string;
  ebayCategory: string;
  ebayStoreCategory: string;
  ebayCondition: string;
  ebayConditionDescription?: string;
  ebayImageUrls: string[];
  ebayAspectParam: Record<string, unknown>;
  ebayFulfillmentPolicy: string;
  listingId?: string;
  orgExtraParam: {
    isPayOnDelivery: boolean;
    rateScore: number;
    rateCount: number;
    shippedFrom: string;
    shippedWithin: string;
    shippingMethod: string;
    sellerId: string;
    itemCondition: string;
  };
}

interface AppParams {
  ebayIsSandbox: boolean;
  ebayAppKeySsmParamName: string;
  ebayUserTokenSsmParamPrefix: string;
  usdJpy: number;
}

interface Body {
  item: Item;
  user: User;
  appParams: AppParams;
}

const QUEUE_URL = process.env.QUEUE_URL!;
const TABLE_NAME = process.env.TABLE_NAME!;

const sqsClient = new SQSClient({
  region: "ap-northeast-1",
});

let total_success = 0;
let total_error = 0;
let consecutive_error = 0;

const isBanListing = (
  item: Item,
  user: User,
  stockInfo: ScrapeResult<Merc | Mshop>
) => {
  return (
    stockInfo.stockStatus === "outofstock" ||
    stockInfo.stockData == null ||
    item.orgImageUrls.toString() !==
      stockInfo.stockData.core.imageUrls.toString() ||
    stockInfo.stockData.core.price >= 100000 ||
    stockInfo.stockData.extra.isPayOnDelivery ||
    stockInfo.stockData.extra.rateScore < 4.8 ||
    stockInfo.stockData.extra.rateCount < 10 ||
    stockInfo.stockData.extra.shippedFrom === "沖縄県" ||
    stockInfo.stockData.extra.shippedFrom === "海外" ||
    (stockInfo.stockData.extra.shippedWithin === "4~7日で発送" &&
      stockInfo.stockData.extra.shippingMethod.includes("普通郵便")) ||
    (stockInfo.stockData.extra.shippedWithin === "4~7日で発送" &&
      stockInfo.stockData.extra.shippingMethod === "未定") ||
    stockInfo.stockData.extra.itemCondition === "新品、未使用" ||
    [
      "即購入禁止",
      "即購入不可",
      "コメント必須",
      "海外製",
      "海外から発送",
      "海外からの発送",
    ].some((keyword) =>
      stockInfo.stockData?.core.description.includes(keyword)
    ) ||
    user.sellerBlacklist.includes(stockInfo.stockData.extra.sellerId)
    // item.lastUpdated !== "半年以上前" &&
    // 該当商品が売れた場合、売れてから仕入れるまでのラグを考慮して48時間経過するまでは再出品しない。
    // 売れた後、より安い商品が見つかった場合など必ずしも同一商品を仕入れない可能性があるので、再出品できる余地を残す。
    // (!item.soldTimeStamp || currentTime - item.soldTimeStamp > 172800)
  );
};

async function pollMessage(context: BrowserContext) {
  const receiveCommand = new ReceiveMessageCommand({
    QueueUrl: QUEUE_URL,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 3,
  });
  const response = await sqsClient.send(receiveCommand);

  if (!response.Messages || response.Messages.length === 0) {
    console.log("No messages received");
    return;
  }

  const message = response.Messages[0];
  if (!message?.Body) {
    console.error("Message body is empty");
    return;
  }

  const body: Body = JSON.parse(message.Body);
  console.log(
    JSON.stringify({ body }, (_, v) => (v === undefined ? "!!UNDEFINED!!" : v))
  );

  const stockInfo = await runPlaywright(
    body.item.orgPlatform,
    body.item.orgUrl,
    context
  );
  console.log(
    JSON.stringify({ stockInfo }, (_, v) =>
      v === undefined ? "!!UNDEFINED!!" : v
    )
  );

  const isBan = isBanListing(body.item, body.user, stockInfo);

  let item = structuredClone(body.item);
  item.isOrgLive = stockInfo.stockStatus === "instock";
  if (item.isOrgLive && stockInfo.stockData) {
    const stock = stockInfo.stockData;
    item = {
      ...item,
      orgImageUrls: stock.core.imageUrls,
      orgPrice: stock.core.price,
      orgTitle: stock.core.title,
      orgExtraParam: stock.extra,
      isImageChanged:
        item.isImageChanged ||
        item.orgImageUrls.toString() !== stock.core.imageUrls.toString(),
    };
  }
  if (isBan) {
    console.log("retrieve item ", item.id);
    item = {
      ...item,
      isListed: false,
    };
    await retrieveItem(item, body.user, body.appParams);
  } else {
    console.log("list item ", item.id);
    const listingId = await listItem(item, body.user, body.appParams);
    item.listingId = listingId;
  }

  // db更新
  const { id, ...updateInput } = item;
  console.log(
    JSON.stringify({ updateInput }, (_, v) =>
      v === undefined ? "!!UNDEFINED!!" : v
    )
  );
  await ddb.updateItem(TABLE_NAME, "id", id, updateInput);

  // メッセージを正常に処理したら削除
  const deleteCommand = new DeleteMessageCommand({
    QueueUrl: QUEUE_URL,
    ReceiptHandle: message.ReceiptHandle,
  });
  await sqsClient.send(deleteCommand);

  total_success += 1;
  consecutive_error = 0;
}

// ポーリングを開始
async function startPolling() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
  });

  while (true) {
    if (consecutive_error > 4 || total_error > 20) {
      console.error("Poling ended because of too many errors");
      break;
    }
    if (total_success > 1000) {
      console.log("Polling ended because of too many successes");
      break;
    }
    const start = Date.now();
    try {
      await pollMessage(context);
    } catch (error: any) {
      console.error(
        JSON.stringify({
          message: "[ERROR] Error occured in polling.",
          content: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        })
      );
      total_error += 1;
      consecutive_error += 1;
    }
    const elapsed = Date.now() - start;
    if (elapsed < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 5000 - elapsed));
    }
  }
}

startPolling()
  .catch((error) => {
    console.error(
      JSON.stringify({
        message: "[ERROR] polling accidently ended.",
        content: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      })
    );
  })
  .finally(() => {
    console.log(
      JSON.stringify({
        message: "Polling ended.",
        content: { total_success, total_error, consecutive_error },
      })
    );
  });
