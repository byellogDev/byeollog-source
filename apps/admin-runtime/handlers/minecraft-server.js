import { getMinecraftServerHandler } from "../lib/minecraft-server-runtime.mjs";

export default async function minecraftServerApi(req, res) {
  return getMinecraftServerHandler(process.env)(req, res);
}

