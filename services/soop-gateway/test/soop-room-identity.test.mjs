import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSoopRoomOwner} from '../lib/soop-room-identity.js';

test('JOIN owner session suffix normalizes to the authenticated account',()=>{
  for(const value of ['fixture','fixture(0)','fixture(2)','fixture(123)','FIXTURE(2)'])assert.equal(normalizeSoopRoomOwner(value),'fixture');
});
test('other owners and malformed suffixes cannot become the expected account',()=>{
  assert.equal(normalizeSoopRoomOwner('other(2)'),'other');
  for(const value of ['',null,'fixture(2)other','fixture(2)(3)','fixture(x)','fixture(-1)','fixture(2)\n',' fixture(2)','fixture\0(2)','fixture(12345678901)'])assert.equal(normalizeSoopRoomOwner(value),'');
});
