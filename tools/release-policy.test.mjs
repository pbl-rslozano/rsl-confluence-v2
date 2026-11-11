import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseMutationAllowed } from './release-policy.mjs';
const base = {requestedDraft:true, existingDraft:true, expectedTarget:'abc', existingTarget:'abc'};
test('draft rerun may update the same draft commit',()=>assert.doesNotThrow(()=>assertReleaseMutationAllowed(base)));
test('draft request cannot change a published release',()=>assert.throws(()=>assertReleaseMutationAllowed({...base,existingDraft:false}),/published/));
test('explicit publication may update the same published commit',()=>assert.doesNotThrow(()=>assertReleaseMutationAllowed({...base,requestedDraft:false,existingDraft:false})));
test('a different source commit is refused for draft and published releases',()=>{for(const requestedDraft of [true,false])assert.throws(()=>assertReleaseMutationAllowed({...base,requestedDraft,existingTarget:'other'}),/another commit/);});
