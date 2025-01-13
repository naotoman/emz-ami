import { BrowserContext, Page } from "playwright";
import { Merc, Mshop, scrapeMerc, scrapeMshop, ScrapeResult } from "./scraper";

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

export const runPlaywright = async (
  platform: string,
  url: string,
  context: BrowserContext
) => {
  const scraper = (() => {
    if (platform === "merc") {
      return playMerc;
    } else if (platform === "mshop") {
      return playMshop;
    } else {
      throw new Error(`invalid platform: ${platform}`);
    }
  })();
  const page = await context.newPage();
  try {
    await page.goto(url);
    const result = await scraper(page);
    return result;
  } finally {
    await page.close();
  }
};
