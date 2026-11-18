import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('Android upgrade version stays above the shipped date-based version', () => {
 const dir=mkdtempSync(join(tmpdir(),'rsl-version-'));
 try {
 mkdirSync(join(dir,'tools')); mkdirSync(join(dir,'apps/confluence/mobile/android/app'),{recursive:true});
 mkdirSync(join(dir,'apps/confluence/web/src/rsl'),{recursive:true});
 writeFileSync(join(dir,'package.json'),JSON.stringify({version:'2.4.0'}));
 writeFileSync(join(dir,'apps/confluence/web/src/rsl/app-info.ts'),'version: "2.4", build: "20261105"');
 const gradle=join(dir,'apps/confluence/mobile/android/app/build.gradle');
 writeFileSync(gradle,'versionCode 20261101\nversionName "2.3"');
 copyFileSync(new URL('./set-android-version.mjs',import.meta.url),join(dir,'tools/set-android-version.mjs'));
 execFileSync(process.execPath,[join(dir,'tools/set-android-version.mjs')],{env:{...process.env,GITHUB_RUN_NUMBER:'12'}});
 const result=readFileSync(gradle,'utf8'); assert.ok(Number(/versionCode (\d+)/.exec(result)[1]) > 20261101,result);
 assert.match(result,/versionName "2.4.0"/);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

// 18 Nov 2026 (fix round 1, I5): versionCode = build * 100 + (run number % 100). The 2.7.0 APK came from another
// repository with an unknown run number (code = 20261111 + run), so 2.8.0 must sit above every such code.
function codeFor(build, run) {
 const dir=mkdtempSync(join(tmpdir(),'rsl-version-'));
 try {
 mkdirSync(join(dir,'tools')); mkdirSync(join(dir,'apps/confluence/mobile/android/app'),{recursive:true});
 mkdirSync(join(dir,'apps/confluence/web/src/rsl'),{recursive:true});
 writeFileSync(join(dir,'package.json'),JSON.stringify({version:'2.8.0'}));
 writeFileSync(join(dir,'apps/confluence/web/src/rsl/app-info.ts'),`version: "2.8.0", build: "${build}"`);
 const gradle=join(dir,'apps/confluence/mobile/android/app/build.gradle');
 writeFileSync(gradle,'versionCode 1\nversionName "2.7.0"');
 copyFileSync(new URL('./set-android-version.mjs',import.meta.url),join(dir,'tools/set-android-version.mjs'));
 execFileSync(process.execPath,[join(dir,'tools/set-android-version.mjs')],{env:{...process.env,GITHUB_RUN_NUMBER:String(run)},stdio:'pipe'});
 return Number(/versionCode (\d+)/.exec(readFileSync(gradle,'utf8'))[1]);
 } finally { rmSync(dir,{recursive:true,force:true}); }
}
test('versionCode is build * 100 + run number mod 100', () => {
 assert.equal(codeFor('20261118', 36), 2026111836);
 assert.equal(codeFor('20261118', 0), 2026111800);
});
test('2.8.0 codes are above every 2.7.0 code (20261111 + any run number)', () => {
 assert.ok(codeFor('20261118', 0) > 20261111 + 999999);
});
test('the Android cap (2,100,000,000) holds through 2099', () => {
 const c = codeFor('20991231', 99);
 assert.equal(c, 2099123199);
 assert.ok(c <= 2100000000);
});
test('a run number of 100 or more wraps (only same-day builds 100 runs apart can collide)', () => {
 assert.equal(codeFor('20261118', 100), 2026111800);
 assert.equal(codeFor('20261118', 136), 2026111836);
});
