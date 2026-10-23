import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export function verifyDeploymentRegion(config, deployment) {
  assert.ok(Array.isArray(config.regions) && config.regions.length, 'Expected regions are missing');
  assert.ok(Array.isArray(deployment.regions) && deployment.regions.length, 'Actual deployment regions are missing');
  assert.equal(deployment.readyState, 'READY', 'Deployment is not READY');
  assert.deepEqual([...deployment.regions].sort(), [...config.regions].sort(), 'Actual deployment region differs from source configuration');
  return {ready: true, regions: [...deployment.regions]};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configPath, deploymentPath] = process.argv.slice(2);
  if (!configPath || !deploymentPath) throw new Error('Usage: node tools/verify-deployment-region.mjs <vercel.json> <private deployment metadata.json>');
  console.log(JSON.stringify(verifyDeploymentRegion(JSON.parse(fs.readFileSync(configPath)), JSON.parse(fs.readFileSync(deploymentPath)))));
}
