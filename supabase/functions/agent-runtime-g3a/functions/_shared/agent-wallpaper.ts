import { createServiceStorageSignedUrl } from "./server-runtime.ts";
import { compactAgentWallpaperState } from "./agent-wallpaper-payload.js";

type JsonObject = Record<string, unknown>;

const VISIBLE_KEY = /^(donation|challenge_success|subscription):[1-9][0-9]{0,9}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOOP_HOSTS = ["sooplive.com", "afreecatv.com", "afreecatvcdn.com"];

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function safeText(value: unknown, max = 200): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function normalizeSoopUrl(value: unknown): string | null {
  const raw = safeText(value, 2048);
  if (!raw) return null;
  try {
    const candidate = raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
        ? new URL(raw, "https://res.sooplive.com").href
        : raw.replace(/^http:\/\//i, "https://");
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!SOOP_HOSTS.some((root) => host === root || host.endsWith(`.${root}`))) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function defaultCeremonyUrl(amount: number): string {
  const file = amount <= 50 ? "ba_step2.png"
    : amount <= 100 ? "ba_step3.png"
    : amount <= 500 ? "ba_step4.png"
    : amount <= 1000 ? "ba_step5.png"
    : "ba_step6.png";
  return `https://res.sooplive.com/new_player/items/${file}`;
}

function mergeRanges(value: unknown): Array<{ min: number; max: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = object(item);
    return { min: integer(row?.min), max: integer(row?.max) };
  }).filter((item) => item.min >= 1 && item.max >= item.min && item.max <= 1_000_000)
    .sort((left, right) => left.min - right.min || left.max - right.max)
    .slice(0, 20);
}

function assetMetadata(asset: JsonObject | null): JsonObject {
  const sha256 = safeText(asset?.sha256, 64).toLowerCase();
  const mimeType = safeText(asset?.mimeType, 80).toLowerCase();
  const byteSize = integer(asset?.byteSize);
  const width = integer(asset?.width);
  const height = integer(asset?.height);
  return {
    imageSha256: SHA256.test(sha256) ? sha256 : null,
    imageMimeType: ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType) ? mimeType : null,
    imageByteSize: byteSize >= 1 && byteSize <= 12 * 1024 * 1024 ? byteSize : null,
    imageWidth: width >= 1 && width <= 4096 ? width : null,
    imageHeight: height >= 1 && height <= 4096 ? height : null
  };
}

function rouletteAssetUrl(supabaseUrl: string, workspaceId: string, asset: JsonObject | null): string | null {
  const path = safeText(asset?.storagePath, 1000);
  if (!path.startsWith(`workspaces/${workspaceId}/`)) return null;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl}/storage/v1/object/public/byeollog-roulette-assets/${encoded}`;
}

function grouping(amount: number, displayKind: string, ranges: Array<{ min: number; max: number }>) {
  if (displayKind === "challenge_success") {
    return { groupKey: `wallpaper-challenge-success-${amount}`, mergeRange: null };
  }
  if (displayKind === "subscription") {
    return { groupKey: `wallpaper-subscription-${amount}`, mergeRange: null };
  }
  const range = ranges.find((item) => amount >= item.min && amount <= item.max) ?? null;
  return {
    groupKey: range ? `wallpaper-merge-${range.min}-${range.max}` : `wallpaper-amount-${amount}`,
    mergeRange: range
  };
}

export async function buildAgentWallpaperState(
  rawValue: unknown,
  workspaceId: string,
  supabaseUrl: string,
  wallpaperSchemaVersion = 1
): Promise<JsonObject> {
  const raw = object(rawValue);
  if (raw === null) throw new Error("Wallpaper snapshot RPC returned an invalid payload");
  const revision = integer(raw.revision, -1);
  if (revision < 0) throw new Error("Wallpaper snapshot revision is invalid");
  if (raw.changed !== true) return { changed: false, revision };

  const overlay = object(raw.overlay) ?? {};
  const ranges = mergeRanges(overlay.mergeRanges);
  const visibleKeys = new Set(
    (Array.isArray(overlay.visibleGroupKeys) ? overlay.visibleGroupKeys : [])
      .map((value) => safeText(value, 80))
      .filter((value) => VISIBLE_KEY.test(value))
      .slice(0, 500)
  );
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).map(object).filter(Boolean) as JsonObject[];
  const currentSessionId = safeText(raw.currentSessionId, 40);
  const selectedSessionPriority = new Map(
    (Array.isArray(raw.selectedSessionIds) ? raw.selectedSessionIds : [])
      .map((value, index) => [safeText(value, 40), index] as const)
      .filter(([id]) => id.length > 0)
  );
  const newest = sessions.reduce<JsonObject | null>((best, row) => {
    if (best === null) return row;
    return Date.parse(String(row.startedAt ?? "")) > Date.parse(String(best.startedAt ?? "")) ? row : best;
  }, null);
  const canvasWidth = Math.max(1, integer(newest?.canvasWidth, 1920));
  const canvasHeight = Math.max(1, integer(newest?.canvasHeight, 1080));

  const signedSignatures = new Map<number, JsonObject>();
  await Promise.all((Array.isArray(raw.signatures) ? raw.signatures : []).map(async (value) => {
    const row = object(value);
    const amount = integer(row?.amount);
    const asset = object(row?.asset);
    const path = safeText(asset?.storagePath, 1000);
    if (amount < 1 || !path.startsWith(`workspaces/${workspaceId}/wallpaper/`)) return;
    try {
      signedSignatures.set(amount, {
        imageUrl: await createServiceStorageSignedUrl("byeollog-signature-assets", path),
        imageKey: `signature:${path}`,
        source: "signature",
        ...assetMetadata(asset)
      });
    } catch {
      // A broken custom image must not suppress the official SOOP fallback.
    }
  }));

  const workspaceDefaults: Array<{ min: number; max: number; image: JsonObject }> = [];
  await Promise.all((Array.isArray(raw.defaultDonationImages) ? raw.defaultDonationImages : []).map(async (value) => {
    const row = object(value);
    const min = integer(row?.minAmount);
    const max = integer(row?.maxAmount);
    const asset = object(row?.asset);
    const path = safeText(asset?.storagePath, 1000);
    if (min < 1 || max < min || !path.startsWith(`workspaces/${workspaceId}/default-pc/`)) return;
    try {
      workspaceDefaults.push({
        min,
        max,
        image: {
          imageUrl: await createServiceStorageSignedUrl("byeollog-signature-assets", path),
          imageKey: `workspace_default:${path}`,
          source: "workspace_default",
          ...assetMetadata(asset)
        }
      });
    } catch {
      // A broken workspace-owned default must not re-enable a SOOP image for history.
    }
  }));
  workspaceDefaults.sort((left, right) => left.min - right.min || left.max - right.max);

  const activation = object(raw.activationSnapshot);
  const roulette = new Map<number, JsonObject>();
  const singleAmount = integer(activation?.balloonsPerSpin);
  const singleAsset = object(activation?.customSingleImage);
  const singleUrl = rouletteAssetUrl(supabaseUrl, workspaceId, singleAsset);
  if (singleAmount > 0 && singleUrl) roulette.set(singleAmount, {
    imageUrl: singleUrl,
    imageKey: `roulette:${safeText(singleAsset?.storagePath, 1000)}`,
    source: "roulette",
    ...assetMetadata(singleAsset)
  });
  const seriesAmount = integer(activation?.seriesBalloons);
  const seriesAsset = object(activation?.customSeriesImage) ?? singleAsset;
  const seriesUrl = activation?.seriesEnabled === true
    ? rouletteAssetUrl(supabaseUrl, workspaceId, seriesAsset)
    : null;
  if (seriesAmount > 0 && seriesUrl) roulette.set(seriesAmount, {
    imageUrl: seriesUrl,
    imageKey: `roulette:${safeText(seriesAsset?.storagePath, 1000)}`,
    source: "roulette",
    ...assetMetadata(seriesAsset)
  });

  const rows = (Array.isArray(raw.tiles) ? raw.tiles : []).map(object).filter(Boolean) as JsonObject[];
  const latest = new Map<number, JsonObject>();
  for (const row of rows) {
    if (!currentSessionId || safeText(row.sessionId, 40) !== currentSessionId) continue;
    const displayKind = row.displayKind === "challenge_success" ? "challenge_success" : row.displayKind === "subscription" ? "subscription" : "donation";
    if (displayKind === "challenge_success" || displayKind === "subscription" || row.assetSource === "signature") continue;
    const amount = integer(row.amount);
    const asset = object(row.asset);
    const source = safeText(row.assetSource, 40);
    const imageUrl = source === "roulette"
      ? rouletteAssetUrl(supabaseUrl, workspaceId, asset)
      : normalizeSoopUrl(asset?.url);
    if (amount > 0 && imageUrl) latest.set(amount, {
      imageUrl,
      imageKey: `${source}:${safeText(asset?.storagePath ?? asset?.url ?? imageUrl, 2048)}`,
      source,
      ...assetMetadata(asset)
    });
  }

  const tiles: JsonObject[] = [];
  for (const row of rows) {
    const amount = integer(row.amount);
    if (amount < 1) continue;
    const displayKind = row.displayKind === "challenge_success" ? "challenge_success" : row.displayKind === "subscription" ? "subscription" : "donation";
    const visibilityKey = `${displayKind}:${amount}`;
    if (!visibleKeys.has(visibilityKey)) continue;
    const asset = object(row.asset);
    const rowSessionId = safeText(row.sessionId, 40);
    const mayUseSoopEventImage = currentSessionId.length > 0 && rowSessionId === currentSessionId;
    const officialEventUrl = mayUseSoopEventImage && (displayKind === "challenge_success" || displayKind === "subscription")
      ? normalizeSoopUrl(asset?.url)
      : null;
    const workspaceDefault = workspaceDefaults.find((item) => amount >= item.min && amount <= item.max)?.image;
    const noImage = {
      imageUrl: null,
      imageKey: null,
      source: "none",
      imageSha256: null,
      imageMimeType: null,
      imageByteSize: null,
      imageWidth: null,
      imageHeight: null
    };
    const selected = displayKind === "subscription" ? {
      imageUrl: officialEventUrl,
      imageKey: officialEventUrl ? `soop:${officialEventUrl}` : null,
      source: officialEventUrl ? "soop" : "none",
      imageSha256: null,
      imageMimeType: null,
      imageByteSize: null,
      imageWidth: null,
      imageHeight: null
    } : displayKind === "challenge_success" && officialEventUrl ? {
      imageUrl: officialEventUrl,
      imageKey: `soop:${officialEventUrl}`,
      source: "soop",
      ...assetMetadata(asset)
    } : displayKind === "challenge_success" ? noImage
      : signedSignatures.get(amount) ?? roulette.get(amount) ?? (mayUseSoopEventImage ? latest.get(amount) : undefined)
        ?? workspaceDefault
        ?? (mayUseSoopEventImage ? {
          imageUrl: defaultCeremonyUrl(amount),
          imageKey: `soop_default:${defaultCeremonyUrl(amount)}`,
          source: "soop_default",
          imageSha256: null,
          imageMimeType: null,
          imageByteSize: null,
          imageWidth: null,
          imageHeight: null
        } : noImage);
    const grouped = grouping(amount, displayKind, ranges);
    const coordinates = [row.layoutX, row.layoutY, row.layoutWidth, row.layoutHeight].map((value) => integer(value, Number.MIN_SAFE_INTEGER));
    const columns = integer(row.layoutColumns, -1);
    const layoutRows = integer(row.layoutRows, -1);
    const layout = coordinates[0] >= -160 && coordinates[1] >= -90
        && coordinates[2] >= 80 && coordinates[3] >= 60
        && coordinates[0] + coordinates[2] <= canvasWidth + 160
        && coordinates[1] + coordinates[3] <= canvasHeight + 90
      ? {
        x: coordinates[0], y: coordinates[1], width: coordinates[2], height: coordinates[3],
        columns: columns >= 1 ? columns : null,
        rows: layoutRows >= 1 ? layoutRows : null,
        nextSide: row.layoutNextSide === "left" ? "left" : "right",
        layer: integer(row.layoutLayer, 0) >= 1 && integer(row.layoutLayer, 0) <= 216
          ? integer(row.layoutLayer)
          : null
      }
      : null;
    tiles.push({
      id: safeText(row.id, 40),
      sequenceNo: integer(row.sequenceNo),
      sessionId: safeText(row.sessionId, 40),
      layoutPriority: selectedSessionPriority.get(safeText(row.sessionId, 40)) ?? Number.MAX_SAFE_INTEGER,
      actorName: safeText(row.actorName, 120) || "익명",
      amount,
      displayKind,
      visibilityKey,
      receivedAt: safeText(row.receivedAt, 80),
      layout,
      ...grouped,
      ...selected
    });
  }

  const state = {
    schemaVersion: 1,
    revision,
    canvasWidth,
    canvasHeight,
    sizeRanges: (Array.isArray(overlay.sizeRanges) ? overlay.sizeRanges : []).slice(0, 20),
    tiles
  };
  return {
    changed: true,
    revision,
    state: wallpaperSchemaVersion >= 2 ? compactAgentWallpaperState(state) : state
  };
}

