import { createProductionOAuth } from "./game-link-oauth.mjs";
import { createGameLinkHandler } from "./game-link-service.mjs";
import { createStoreFromEnv } from "./game-link-store.mjs";

let handler;

export function getGameLinkHandler(env = process.env) {
  if (!handler) {
    handler = createGameLinkHandler({
      store: createStoreFromEnv(env),
      oauth: createProductionOAuth({ env }),
      env,
    });
  }
  return handler;
}
