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
