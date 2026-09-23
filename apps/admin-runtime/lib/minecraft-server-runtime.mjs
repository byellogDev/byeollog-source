import { createMinecraftServerHandler } from "./minecraft-server-service.mjs";
import { createMinecraftServerStoreFromEnv } from "./minecraft-server-store.mjs";

let handler;

export function getMinecraftServerHandler(env = process.env) {
  if (!handler) {
    handler = createMinecraftServerHandler({
      store: createMinecraftServerStoreFromEnv(env),
    });
  }
  return handler;
}

