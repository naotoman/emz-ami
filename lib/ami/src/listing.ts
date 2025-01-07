import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import {
  createOffer,
  createOrReplaceInventoryItem,
  deleteInventoryItem,
  getOffers,
  mintAccessToken,
  publishOffer,
  updateOffer,
} from "./ebay";
import { myLog } from "./myUtils";
interface User {
  username: string;
  returnPolicy: string;
  paymentPolicy: string;
  profitRatio: number;
  merchantLocationKey: string;
}

interface Item {
  shippingYen: number;
  orgPrice: number;
  ebaySku: string;
  ebayTitle: string;
  ebayDescription: string;
  ebayCategory: string;
  ebayStoreCategory: string;
  ebayCondition: string;
  ebayConditionDescription?: string;
  ebayImageUrls: string[];
  ebayAspectParam: Record<string, unknown>;
  ebayFulfillmentPolicy: string;
  orgExtraParam: Record<string, unknown>;
}

interface AppParams {
  ebayIsSandbox: boolean;
  ebayAppKeySsmParamName: string;
  ebayUserTokenSsmParamPrefix: string;
  usdJpy: number;
}

interface Event {
  command: string;
  user: User;
  item: Item;
  appParams: AppParams;
}

const cacheGetSsmParam = (() => {
  let valueMap = new Map<string, string>();
  return async (ssmParamName: string) => {
    if (valueMap.has(ssmParamName)) {
      return valueMap.get(ssmParamName) || "";
    }
    const ssmClient = new SSMClient({ region: "ap-northeast-1" });
    const value = await ssmClient.send(
      new GetParameterCommand({
        Name: ssmParamName,
        WithDecryption: true,
      })
    );
    valueMap.set(ssmParamName, value.Parameter!.Value!);
    return valueMap.get(ssmParamName) || "";
  };
})();

export const cacheGetAccessToken = async (
  ebayAppKeySsmParamName: string,
  ebayUserTokenSsmParamName: string,
  ebayIsSandbox: boolean
) => {
  const keysStr = await cacheGetSsmParam(ebayAppKeySsmParamName);
  const keys = JSON.parse(keysStr);

  const ssmClient = new SSMClient({ region: "ap-northeast-1" });
  const resToken = await ssmClient.send(
    new GetParameterCommand({
      Name: ebayUserTokenSsmParamName,
      WithDecryption: true,
    })
  );
  const tokens = JSON.parse(resToken.Parameter!.Value!);
  const currentTimestamp = new Date().getTime();
  if (tokens.accessToken.expiresAt - 600000 > currentTimestamp) {
    return tokens.accessToken.value;
  }
  console.log("Token expired. Refreshing...");
  const mintedToken = await mintAccessToken(
    keys["Client ID"],
    keys["Client Secret"],
    tokens.refreshToken,
    ebayIsSandbox
  );
  const newTokens = {
    refreshToken: tokens.refreshToken,
    accessToken: {
      value: mintedToken.access_token,
      expiresAt: (mintedToken.expires_in || 7200) * 1000 + currentTimestamp,
    },
  };
  ssmClient
    .send(
      new PutParameterCommand({
        Name: ebayUserTokenSsmParamName,
        Value: JSON.stringify(newTokens),
        Overwrite: true,
      })
    )
    .then((res) => res)
    .catch((err) => {
      console.log(err);
    });
  return mintedToken.access_token;
};

export const retrieveItem = async (
  item: Item,
  user: User,
  appParams: AppParams
) => {
  const accessToken = await cacheGetAccessToken(
    appParams.ebayAppKeySsmParamName,
    appParams.ebayUserTokenSsmParamPrefix + user.username,
    appParams.ebayIsSandbox
  );
  await deleteInventoryItem(accessToken, item.ebaySku, appParams.ebayIsSandbox);
};

export const listItem = async (
  item: Item,
  user: User,
  appParams: AppParams
) => {
  const inventoryPayload = {
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
      },
    },
    condition: item.ebayCondition,
    product: {
      title: item.ebayTitle,
      description: item.ebayDescription,
      imageUrls: item.ebayImageUrls,
      aspects: item.ebayAspectParam,
    },
    ...(item.ebayConditionDescription
      ? { conditionDescription: item.ebayConditionDescription }
      : {}),
  };
  myLog({ inventoryPayload });

  const price =
    (item.orgPrice + item.shippingYen) /
    (appParams.usdJpy * (1 - user.profitRatio - 0.17)); // 17% is approximate eBay sales fee + payoneer fee

  const offerPayload = {
    sku: item.ebaySku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: item.ebayCategory,
    listingPolicies: {
      fulfillmentPolicyId: item.ebayFulfillmentPolicy,
      paymentPolicyId: user.paymentPolicy,
      returnPolicyId: user.returnPolicy,
    },
    pricingSummary: { price: { currency: "USD", value: price.toFixed(2) } },
    merchantLocationKey: user.merchantLocationKey,
    storeCategoryNames: [item.ebayStoreCategory],
  };
  myLog({ offerPayload });

  const accessToken = await cacheGetAccessToken(
    appParams.ebayAppKeySsmParamName,
    appParams.ebayUserTokenSsmParamPrefix + user.username,
    appParams.ebayIsSandbox
  );
  await createOrReplaceInventoryItem(
    accessToken,
    item.ebaySku,
    inventoryPayload,
    appParams.ebayIsSandbox
  );

  const offer = await getOffers(
    accessToken,
    item.ebaySku,
    appParams.ebayIsSandbox
  );
  let offerId = "";
  if (offer.exist) {
    offerId = offer.data.offerId;
    await updateOffer(
      accessToken,
      offerId,
      offerPayload,
      appParams.ebayIsSandbox
    );
  } else {
    const offer = await createOffer(
      accessToken,
      offerPayload,
      appParams.ebayIsSandbox
    );
    offerId = offer.offerId;
  }
  const listing = await publishOffer(
    accessToken,
    offerId,
    appParams.ebayIsSandbox
  );
  return listing.listingId;
};
