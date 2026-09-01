import assert from "node:assert/strict";
import test from "node:test";
import {
  compactAgentWallpaperState,
  wallpaperStateWireBytes
} from "../supabase/functions/_shared/agent-wallpaper-payload.js";

function tile(index, imageKey, imageUrl) {
  return {
    id: `tile-${index}`,
    sequenceNo: index,
    actorName: `후원자${index}`,
    amount: 50,
    displayKind: "donation",
    receivedAt: "2026-09-02T00:00:00.000Z",
    source: "signature",
    imageUrl,
    imageKey,
    imageSha256: "a".repeat(64),
    imageMimeType: "image/webp",
    imageByteSize: 123456,
    imageWidth: 512,
    imageHeight: 512
  };
}

test("wallpaper schema v2 sends one image descriptor for repeated cards", () => {
  const imageKey = "signature:workspaces/example/wallpaper/50.webp";
  const imageUrl = `https://example.supabase.co/storage/v1/object/sign/bucket/image.webp?token=${"x".repeat(300)}`;
  const state = {
    schemaVersion: 1,
    revision: 42,
    canvasWidth: 1920,
    canvasHeight: 1080,
    tiles: Array.from({ length: 100 }, (_, index) => tile(index, imageKey, imageUrl))
  };
  const compact = compactAgentWallpaperState(state);
  assert.equal(compact.schemaVersion, 2);
  assert.equal(compact.assets.length, 1);
  assert.ok(compact.tiles.every((item) => item.assetIndex === 0));
  assert.ok(compact.tiles.every((item) => !("imageUrl" in item) && !("imageKey" in item)));
  assert.ok(wallpaperStateWireBytes(compact) < wallpaperStateWireBytes(state) * 0.45);
});

test("compaction keeps schema v1 when a tiny snapshot would grow", () => {
  const state = {
    schemaVersion: 1,
    revision: 1,
    canvasWidth: 1920,
    canvasHeight: 1080,
    tiles: []
  };
  assert.equal(compactAgentWallpaperState(state).schemaVersion, 1);
});
