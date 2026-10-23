import test from 'node:test';import assert from 'node:assert/strict';
import {nextRetentionReviewAt} from '../apps/backup-worker/lib/retention-checkpoint.js';
const day=86400000,now=Date.parse('2026-09-26T00:00:00Z');
test('empty archives still get a daily safety recheck',()=>assert.equal(nextRetentionReviewAt({tables:{}},now),now+day));
test('next tile expiry is not hidden by a successful earlier scan',()=>assert.equal(nextRetentionReviewAt({tables:{byeollog_wallpaper_tiles:[{received_at:new Date(now-7*day+1800000).toISOString()}]}},now),now+1800000));
test('closed session expiry requires a recheck even without tiles',()=>assert.equal(nextRetentionReviewAt({tables:{byeollog_wallpaper_sessions:[{state:'closed',closed_at:new Date(now-7*day+5000).toISOString()}]}},now),now+5000));
test('invalid timestamps disable skipping',()=>assert.equal(nextRetentionReviewAt({tables:{byeollog_wallpaper_tiles:[{received_at:'broken'}]}},now),now));
test('already-due rows never yield a future checkpoint',()=>assert.ok(nextRetentionReviewAt({tables:{byeollog_wallpaper_tiles:[{received_at:new Date(now-8*day).toISOString()}]}},now)<=now));
