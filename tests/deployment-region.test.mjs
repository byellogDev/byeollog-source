import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDeploymentRegion} from '../tools/verify-deployment-region.mjs';

test('accepts a ready deployment in the configured region', () => {
  assert.deepEqual(verifyDeploymentRegion({regions:['hnd1']}, {readyState:'READY',regions:['hnd1']}), {ready:true,regions:['hnd1']});
});
test('rejects a deployment that fell back to a different region', () => {
  assert.throws(() => verifyDeploymentRegion({regions:['hnd1']}, {readyState:'READY',regions:['iad1']}));
});
test('does not interpret missing configuration or metadata as success', () => {
  assert.throws(() => verifyDeploymentRegion({}, {readyState:'READY',regions:['hnd1']}));
  assert.throws(() => verifyDeploymentRegion({regions:['hnd1']}, {readyState:'READY'}));
});
test('rejects unfinished builds and unexpected additional regions', () => {
  assert.throws(() => verifyDeploymentRegion({regions:['hnd1']}, {readyState:'BUILDING',regions:['hnd1']}));
  assert.throws(() => verifyDeploymentRegion({regions:['hnd1']}, {readyState:'READY',regions:['hnd1','iad1']}));
});
