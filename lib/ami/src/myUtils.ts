import * as util from "util";

/**
 * Logs the object to the console.
 * @param obj - An object to be logged.
 */
export const myLog = (obj: unknown) => {
  console.log(util.inspect(obj, { depth: null }));
};
