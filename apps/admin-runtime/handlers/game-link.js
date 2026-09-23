import { getGameLinkHandler } from "../lib/game-link-runtime.mjs";

export default async function gameLinkApi(req, res) {
  return getGameLinkHandler(process.env)(req, res);
}
