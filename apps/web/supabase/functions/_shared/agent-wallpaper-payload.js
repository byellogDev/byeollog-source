const ASSET_FIELDS = Object.freeze([
  "source",
  "imageUrl",
  "imageKey",
  "imageSha256",
  "imageMimeType",
  "imageByteSize",
  "imageWidth",
  "imageHeight"
]);

function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Schema v2 removes repeated image descriptors from wallpaper tiles. The
 * Agent expands this back to schema v1 before it touches the local renderer,
 * so this function only changes network bytes, never visual behavior.
 */
export function compactAgentWallpaperState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.tiles)) return state;

  const assets = [];
  const assetIndexes = new Map();
  const tiles = state.tiles.map((tile) => {
    const compact = { ...tile };
    const descriptor = {};
    for (const field of ASSET_FIELDS) {
      descriptor[field] = compact[field] ?? null;
      delete compact[field];
    }

    if (typeof descriptor.imageKey !== "string" || descriptor.imageKey.length < 1) {
      compact.assetIndex = null;
      return compact;
    }

    const identity = JSON.stringify(descriptor);
    let assetIndex = assetIndexes.get(identity);
    if (assetIndex === undefined) {
      assetIndex = assets.length;
      assets.push(descriptor);
      assetIndexes.set(identity, assetIndex);
    }
    compact.assetIndex = assetIndex;
    return compact;
  });

  const candidate = { ...state, schemaVersion: 2, assets, tiles };
  return utf8Bytes(candidate) < utf8Bytes(state) ? candidate : state;
}

export function wallpaperStateWireBytes(state) {
  return utf8Bytes(state);
}
