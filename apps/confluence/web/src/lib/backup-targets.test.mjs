// WP28 Task 5: the storage targets. A fake BackupHttp per provider records requests and stores files; nothing
// touches the network. Run: npm run test:backup-targets   (node scripts/run-engine-tests.mjs backup-targets.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { BackupError, BACKUP_MAX_FILE_BYTES, sealBackup, openBackup } from "./backup-crypto.ts";
import { setSession, getSession, clearAllSessions } from "./backup-session.ts";
import { isAllowedBackupUrl } from "./public-hosts.ts";
import { gdriveTarget, onedriveTarget, pcloudTarget, multipartBody } from "./backup-targets.ts";

const TOKEN = "FAKE-TOKEN-NOT-REAL-0001";
const PASS = "correct horse battery staple";
const TEXT = JSON.stringify({ hello: "world", n: [1, 2, 3] });
const NAME = "confluence-backup-20261117T101500Z.json";
const DL_ORIGIN = "https://dl.example.test";
const sess = (extra = {}) => ({ token: TOKEN, expiresAt: null, ...extra });
const json = (status, obj, headers = {}) => ({ status, headers, text: JSON.stringify(obj) });
const MIB20 = BACKUP_MAX_FILE_BYTES;

let sealed;
async function seal() {
  sealed ??= await sealBackup(TEXT, PASS, { createdAt: Date.UTC(2026, 10, 17, 10, 15), app: "test", zip: "none" });
  return sealed;
}
function flip(file) {
  const o = JSON.parse(file);
  o.ct = (o.ct[0] === "A" ? "B" : "A") + o.ct.slice(1);
  return JSON.stringify(o);
}

/** Fakes. Each stores files in `files` (id -> {name, text, modified}) and records every request in `reqs`. */
function fakeGdrive(o = {}) {
  const files = new Map();
  const reqs = [];
  let pendingName = null;
  const LOC = o.location ?? "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=FAKEUPLOAD1";
  const http = async (r) => {
    reqs.push(r);
    if (o.status) return { status: o.status, headers: {}, text: "upstream secret text" };
    if (r.method === "POST" && r.url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")) {
      pendingName = JSON.parse(r.body).name;
      return { status: 200, headers: { location: LOC }, text: "" };
    }
    if (r.method === "PUT") {
      const id = "gdriveid" + String(files.size + 1).padStart(4, "0");
      files.set(id, { name: pendingName, text: r.body, modified: new Date(Date.UTC(2026, 10, 1, 0, files.size)).toISOString() });
      return json(200, { id, name: pendingName });
    }
    if (r.method === "GET" && r.url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      if (o.listBody) return json(200, o.listBody);
      return json(200, { files: [...files].map(([id, f]) => ({ id, name: f.name, size: String(f.text.length), modifiedTime: f.modified })) });
    }
    const m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?alt=media$/.exec(r.url);
    if (r.method === "GET" && m) return { status: 200, headers: {}, text: o.big ? "x".repeat(MIB20 + 1) : files.get(m[1]).text };
    return { status: 404, headers: {}, text: "" };
  };
  return { http, files, reqs };
}

function fakeOnedrive(o = {}) {
  const files = new Map();
  const reqs = [];
  const http = async (r) => {
    reqs.push(r);
    if (o.status) return { status: o.status, headers: {}, text: "upstream secret text" };
    let m = /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/special\/approot:\/([^:]+):\/content$/.exec(r.url);
    if (r.method === "PUT" && m) {
      const id = "OD" + (files.size + 1) + "!" + (100 + files.size);
      files.set(id, { name: m[1], text: r.body, modified: new Date(Date.UTC(2026, 10, 1, 0, files.size)).toISOString() });
      return json(201, { id, name: m[1] });
    }
    if (r.method === "GET" && r.url.startsWith("https://graph.microsoft.com/v1.0/me/drive/special/approot/children?")) {
      if (o.listBody) return json(200, o.listBody);
      return json(200, { value: [...files].map(([id, f]) => ({ id, name: f.name, size: f.text.length, lastModifiedDateTime: f.modified })) });
    }
    m = /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/([^?]+)\?/.exec(r.url);
    if (r.method === "GET" && m) {
      const f = files.get(m[1]);
      return json(200, { id: m[1], size: f.text.length, "@microsoft.graph.downloadUrl": o.downloadUrl ?? DL_ORIGIN + "/dl/FAKEGRANT?token=x" });
    }
    if (r.url.startsWith(DL_ORIGIN + "/dl/")) {
      const f = [...files.values()][0];
      return { status: 200, headers: {}, text: o.big ? "x".repeat(MIB20 + 1) : f.text };
    }
    return { status: 404, headers: {}, text: "" };
  };
  return { http, files, reqs };
}

function fakePcloud(o = {}) {
  let folder = false;
  const files = new Map();
  const reqs = [];
  const http = async (r) => {
    reqs.push(r);
    if (o.status) return { status: o.status, headers: {}, text: "upstream secret text" };
    if (o.result !== undefined) return json(200, { result: o.result, error: "Log in required. secret" });
    const u = new URL(r.url);
    if (u.pathname === "/createfolderifnotexists") {
      if (u.searchParams.get("path") !== "/rsL Confluence Backup") return json(200, { result: 2001 });
      folder = true;
      return json(200, { result: 0, metadata: { folderid: 77, name: "rsL Confluence Backup", isfolder: true } });
    }
    if (r.method === "POST" && u.pathname === "/uploadfile") {
      if (!folder || u.searchParams.get("path") !== "/rsL Confluence Backup") return json(200, { result: 2005 });
      const m = /filename="([^"]+)"/.exec(r.body);
      const text = r.body.split("\r\n\r\n")[1].split("\r\n--")[0];
      const fileid = 5000 + files.size;
      files.set(String(fileid), { name: m[1], text, modified: new Date(Date.UTC(2026, 10, 1, 0, files.size)).toUTCString() });
      return json(200, { result: 0, metadata: [{ fileid, name: m[1] }] });
    }
    if (u.pathname === "/listfolder") {
      if (u.searchParams.get("path") !== "/rsL Confluence Backup" || (!folder && !o.contents)) return json(200, { result: 2005, error: "Directory does not exist." });
      if (o.contents) return json(200, { result: 0, metadata: { contents: o.contents } });
      return json(200, {
        result: 0,
        metadata: { contents: [...files].map(([id, f]) => ({ fileid: Number(id), name: f.name, size: f.text.length, modified: f.modified, isfolder: false })) },
      });
    }
    if (u.pathname === "/gettextfile") {
      if (o.big) return { status: 200, headers: {}, text: "x".repeat(MIB20 + 1) };
      return { status: 200, headers: {}, text: files.get(u.searchParams.get("fileid")).text };
    }
    return { status: 404, headers: {}, text: "" };
  };
  return { http, files, reqs };
}

const PROVIDERS = {
  gdrive: { make: (s, h) => gdriveTarget(s, h), fake: fakeGdrive, wrap: (fn) => fn() },
  onedrive: { make: (s, h) => onedriveTarget(s, h, { downloadOrigins: [DL_ORIGIN] }), fake: fakeOnedrive, wrap: (fn) => fn() },
  pcloud: { make: (s, h) => pcloudTarget(s, h), fake: fakePcloud, wrap: (fn) => fn(), session: { apiHost: "eapi.pcloud.com" } },
};

for (const [id, P] of Object.entries(PROVIDERS)) {
  test(`round trip ${id} (spec)`, async () => {
    const file = await seal();
    await P.wrap(async () => {
      const f = P.fake();
      const t = P.make(sess(P.session), f.http);
      assert.equal(t.provider, id);
      const up = await t.upload(NAME, file);
      assert.equal(up.name, NAME);
      const first = (await t.list())[0];
      assert.equal(first.name, NAME);
      assert.equal(first.id, up.id);
      const back = await t.download(first);
      assert.equal(back, file);
      const { plain } = await openBackup(back, PASS);
      assert.equal(plain, TEXT);
      for (const r of f.reqs) {
        assert.ok(isAllowedBackupUrl(r.url) || r.url.startsWith(DL_ORIGIN), "every request is gated");
        if (!r.url.startsWith(DL_ORIGIN)) assert.equal(r.headers.Authorization, "Bearer " + TOKEN);
      }
    });
  });

  test(`a flipped byte in the stored ${id} file fails to open (spec)`, async () => {
    const file = await seal();
    await P.wrap(async () => {
      const f = P.fake();
      const t = P.make(sess(P.session), f.http);
      await t.upload(NAME, file);
      for (const v of f.files.values()) v.text = flip(v.text);
      const back = await t.download((await t.list())[0]);
      await assert.rejects(openBackup(back, PASS), (e) => e instanceof BackupError && (e.code === "decrypt" || e.code === "format"));
    });
  });

  test(`wrong passphrase on a downloaded ${id} file fails (spec)`, async () => {
    const file = await seal();
    await P.wrap(async () => {
      const f = P.fake();
      const t = P.make(sess(P.session), f.http);
      await t.upload(NAME, file);
      const back = await t.download((await t.list())[0]);
      await assert.rejects(openBackup(back, "another long passphrase here"), (e) => e instanceof BackupError && e.code === "decrypt");
    });
  });

  test(`oversize ${id} download is refused`, async () => {
    await P.wrap(async () => {
      const f = P.fake({ big: true });
      const t = P.make(sess(P.session), f.http);
      await t.upload(NAME, TEXT);
      const info = (await t.list())[0];
      await assert.rejects(t.download(info), (e) => e instanceof BackupError && e.code === "too-large-file");
      await assert.rejects(t.download({ ...info, size: MIB20 + 1 }), (e) => e.code === "too-large-file");
    });
  });

  test(`${id}: 401 clears the session and 5xx maps to http without upstream text`, async () => {
    for (const [status, code] of [[401, "session"], [403, "session"], [500, "http"], [404, "http"]]) {
      clearAllSessions();
      setSession(id, sess(P.session));
      const t = P.make(getSession(id), P.fake({ status }).http);
      await assert.rejects(t.list(), (e) => {
        assert.ok(e instanceof BackupError);
        assert.equal(e.code, code);
        if (code === "http") assert.deepEqual(e.detail, { status });
        assert.ok(!/upstream|secret/.test(JSON.stringify(e.detail) + e.message), "no upstream text");
        assert.ok(!(e.message + JSON.stringify(e.detail)).includes(TOKEN), "no token");
        return true;
      });
      assert.equal(getSession(id) === null, code === "session");
    }
    clearAllSessions();
  });

  test(`${id}: upload refuses a name outside the backup pattern and an oversize text`, async () => {
    const f = P.fake();
    const t = P.make(sess(P.session), f.http);
    for (const bad of ["x.json", "../confluence-backup-20261117T101500Z.json", "confluence-backup-20261117T101500Z.json%2e", "a/b"]) {
      await assert.rejects(t.upload(bad, TEXT), (e) => e.code === "format");
    }
    await assert.rejects(t.upload(NAME, "x".repeat(MIB20 + 1)), (e) => e.code === "too-large-file");
    assert.equal(f.reqs.length, 0, "nothing was sent");
  });

  test(`${id}: list filters foreign files and sorts newest first, at most 20`, async () => {
    await P.wrap(async () => {
      const f = P.fake();
      const t = P.make(sess(P.session), f.http);
      for (let i = 0; i < 25; i++) {
        const n = `confluence-backup-202611${String(i + 1).padStart(2, "0")}T000000Z.json`;
        await t.upload(n, TEXT);
      }
      // foreign entries, straight into the fake's store
      for (const [name, k] of [["notes.txt", 900], ["confluence-backup-bad.json", 901]]) {
        const key = id === "gdrive" ? "gdriveid" + k : id === "onedrive" ? "OD" + k + "!1" : String(k);
        f.files.set(key, { name, text: "x", modified: new Date(Date.UTC(2026, 10, 30)).toISOString() });
      }
      const l = await t.list();
      assert.equal(l.length, 20);
      assert.ok(l.every((x) => /^confluence-backup-\d{8}T\d{6}Z\.json$/.test(x.name)));
      for (let i = 1; i < l.length; i++) assert.ok(l[i - 1].modifiedAt >= l[i].modifiedAt);
    });
  });
}

test("OneDrive download needs a listed origin", async () => {
  const f = fakeOnedrive();
  const t = onedriveTarget(sess(), f.http);
  await t.upload(NAME, TEXT);
  const info = (await t.list())[0];
  await assert.rejects(t.download(info), (e) => {
    assert.ok(e instanceof BackupError);
    assert.equal(e.code, "download-host");
    assert.deepEqual(e.detail, { origin: DL_ORIGIN });
    assert.ok(!JSON.stringify(e.detail).includes("FAKEGRANT"), "origin only: no path or query");
    return true;
  });
  assert.ok(!f.reqs.some((r) => r.url.startsWith(DL_ORIGIN)), "no request to the unlisted host");

  const f2 = fakeOnedrive();
  const t2 = onedriveTarget(sess(), f2.http, { downloadOrigins: [DL_ORIGIN] });
  await t2.upload(NAME, TEXT);
  assert.equal(await t2.download((await t2.list())[0]), TEXT);
  const dl = f2.reqs.find((r) => r.url.startsWith(DL_ORIGIN));
  assert.ok(dl, "the listed host was fetched");
  assert.equal(Object.keys(dl.headers ?? {}).filter((k) => k.toLowerCase() === "authorization").length, 0);
  // the deps of one target do not leak into another
  const f3 = fakeOnedrive();
  const t3 = onedriveTarget(sess(), f3.http);
  await t3.upload(NAME, TEXT);
  await assert.rejects(t3.download((await t3.list())[0]), (e) => e.code === "download-host");
});

test("OneDrive: the target's own gate refuses a download URL the gate rejects, even on a listed origin", async () => {
  for (const downloadUrl of [DL_ORIGIN + "/a/../b", DL_ORIGIN + "/a%2e%2e/b", "https://user@dl.example.test/x", DL_ORIGIN + "/a\\b"]) {
    const f = fakeOnedrive({ downloadUrl });
    const t = onedriveTarget(sess(), f.http, { downloadOrigins: [DL_ORIGIN] });
    await t.upload(NAME, TEXT);
    await assert.rejects(t.download((await t.list())[0]), (e) => e instanceof BackupError && e.code === "unavailable", downloadUrl);
    assert.ok(!f.reqs.some((r) => !r.url.startsWith("https://graph.microsoft.com")), "nothing sent to the host: " + downloadUrl);
  }
  // and any request to a URL outside the table never reaches the port
  const seen = [];
  const t = gdriveTarget(sess(), async (r) => { seen.push(r.url); return { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files/../x" }, text: "" }; });
  await assert.rejects(t.upload(NAME, TEXT), (e) => e.code === "http");
  assert.equal(seen.length, 1, "only the first POST was sent");
});

test("onedriveTarget refuses a malformed extra origin and nothing exported widens the gate", async () => {
  for (const bad of ["http://x.example.test", "https://x.example.test/path", "x"]) {
    assert.throws(() => onedriveTarget(sess(), fakeOnedrive().http, { downloadOrigins: [bad] }), (e) => e.code === "unavailable");
  }
  const mod = await import("./backup-targets.ts");
  assert.ok(!Object.keys(mod).some((k) => /Test/.test(k)), "no test hook is exported");
});

test("OneDrive: a download URL that is not a URL, or a plain http one, is refused", async () => {
  for (const downloadUrl of ["not a url", "http://dl.example.test/x"]) {
    const f = fakeOnedrive({ downloadUrl });
    const t = onedriveTarget(sess(), f.http);
    await t.upload(NAME, TEXT);
    await assert.rejects(t.download((await t.list())[0]), (e) => e.code === "download-host");
    assert.equal(f.reqs.filter((r) => r.method === "GET" && !r.url.startsWith("https://graph.microsoft.com")).length, 0);
  }
});

test("OneDrive upload path is built from the validated name only", async () => {
  const f = fakeOnedrive();
  await onedriveTarget(sess(), f.http).upload(NAME, TEXT);
  assert.equal(f.reqs[0].url, "https://graph.microsoft.com/v1.0/me/drive/special/approot:/" + NAME + ":/content");
  assert.equal(f.reqs[0].method, "PUT");
  assert.equal(f.reqs[0].headers["Content-Type"], "application/json");
});

test("Google resumable upload refuses a foreign location", async () => {
  for (const location of [
    "https://evil.example.test/x",
    "http://www.googleapis.com/upload/drive/v3/files?upload_id=1",
    "https://www.googleapis.com/other/path?upload_id=1",
    "https://oauth2.googleapis.com/token",
    "https://www.googleapis.com@evil.example.test/upload/drive/v3/files",
  ]) {
    const f = fakeGdrive({ location });
    await assert.rejects(gdriveTarget(sess(), f.http).upload(NAME, TEXT), (e) => e instanceof BackupError && e.code === "http");
    assert.ok(!f.reqs.some((r) => r.method === "PUT"), "nothing is PUT: " + location);
  }
  const noLocation = fakeGdrive();
  const http = async (r) => (r.method === "POST" ? { status: 200, headers: {}, text: "" } : noLocation.http(r));
  await assert.rejects(gdriveTarget(sess(), http).upload(NAME, TEXT), (e) => e.code === "http");
});

test("Google requests match the brief", async () => {
  const f = fakeGdrive();
  const t = gdriveTarget(sess(), f.http);
  await t.upload(NAME, TEXT);
  assert.equal(f.reqs[0].url, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable");
  assert.deepEqual(JSON.parse(f.reqs[0].body), { name: NAME, parents: ["appDataFolder"], mimeType: "application/json" });
  assert.equal(f.reqs[1].method, "PUT");
  assert.equal(f.reqs[1].body, TEXT);
  await t.list();
  assert.equal(
    f.reqs[2].url,
    "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=100",
  );
  await assert.rejects(t.download({ id: "../x", name: NAME, size: 1, modifiedAt: 1 }), (e) => e.code === "format");
  await assert.rejects(t.download({ id: "short", name: NAME, size: 1, modifiedAt: 1 }), (e) => e.code === "format");
});

test("pCloud uses the region host and the multipart body", async () => {
  const f = fakePcloud();
  const t = pcloudTarget(sess({ apiHost: "eapi.pcloud.com" }), f.http);
  const file = await seal();
  await t.upload(NAME, file);
  await t.list();
  await t.download((await t.list())[0]);
  for (const r of f.reqs) assert.ok(r.url.startsWith("https://eapi.pcloud.com/"), r.url);
  const up = f.reqs[1];
  assert.equal(up.method, "POST");
  assert.equal(f.reqs[0].url, "https://eapi.pcloud.com/createfolderifnotexists?path=%2FrsL%20Confluence%20Backup");
  assert.equal(up.url, "https://eapi.pcloud.com/uploadfile?path=%2FrsL%20Confluence%20Backup&filename=" + NAME + "&nopartial=1");
  const b = /boundary=(\S+)$/.exec(up.headers["Content-Type"])[1];
  assert.ok(up.body.startsWith("--" + b + "\r\n"));
  assert.ok(up.body.endsWith("\r\n--" + b + "--\r\n"));
  assert.ok(up.body.includes(`filename="${NAME}"`));
  assert.ok(up.body.includes('name="file"'));
  assert.ok(f.reqs.some((r) => r.url === "https://eapi.pcloud.com/listfolder?path=%2FrsL%20Confluence%20Backup"));
  assert.ok(f.reqs.some((r) => /^https:\/\/eapi\.pcloud\.com\/gettextfile\?fileid=\d+$/.test(r.url)));
  // US host too
  const f2 = fakePcloud();
  assert.deepEqual(await pcloudTarget(sess({ apiHost: "api.pcloud.com" }), f2.http).list(), [], "no folder yet: an empty list, not an error");
  assert.equal(f2.reqs[0].url, "https://api.pcloud.com/listfolder?path=%2FrsL%20Confluence%20Backup");
  // no or unknown host: nothing is sent
  const f3 = fakePcloud();
  await assert.rejects(pcloudTarget(sess(), f3.http).list(), (e) => e.code === "unavailable");
  await assert.rejects(pcloudTarget(sess({ apiHost: "evil.example.test" }), f3.http).list(), (e) => e.code === "unavailable");
  assert.equal(f3.reqs.length, 0);
});

test("pCloud: result codes", async () => {
  clearAllSessions();
  setSession("pcloud", sess({ apiHost: "api.pcloud.com" }));
  for (const result of [1000, 2000, 2094]) { // login required, login failed, invalid access_token
    for (const op of ["list", "upload", "download"]) {
      setSession("pcloud", sess({ apiHost: "api.pcloud.com" }));
      const t = pcloudTarget(getSession("pcloud"), fakePcloud({ result }).http);
      const run = op === "list" ? t.list() : op === "upload" ? t.upload(NAME, TEXT) : t.download({ id: "5000", name: NAME, size: 1, modifiedAt: 1 });
      await assert.rejects(run, (e) => e instanceof BackupError && e.code === "session", `${op} ${result}`);
      assert.equal(getSession("pcloud"), null, `${op} ${result} clears the session`);
    }
  }
  for (const result of [2009, 2005, 1001]) {
    await assert.rejects(pcloudTarget(sess({ apiHost: "api.pcloud.com" }), fakePcloud({ result }).http).upload(NAME, TEXT), (e) => {
      assert.equal(e.code, "http");
      assert.deepEqual(e.detail, { status: result });
      assert.ok(!/secret|Log in/.test(e.message + JSON.stringify(e.detail)));
      return true;
    });
  }
  // an error from gettextfile arrives as JSON with a result
  const f = fakePcloud();
  const t = pcloudTarget(sess({ apiHost: "api.pcloud.com" }), f.http);
  await t.upload(NAME, TEXT);
  const info = (await t.list())[0];
  const bad = pcloudTarget(sess({ apiHost: "api.pcloud.com" }), async () => json(200, { result: 2009, error: "x" }));
  await assert.rejects(bad.download(info), (e) => e.code === "http" && e.detail.status === 2009);
});

test("responses with hostile fields", async () => {
  const good = (i) => ({ name: `confluence-backup-2026110${i}T000000Z.json`, modified: "2026-11-0" + i + "T00:00:00Z" });
  // Google
  const gd = fakeGdrive({
    listBody: {
      files: [
        { id: "goodid0001", name: good(1).name, size: "10", modifiedTime: good(1).modified },
        { id: "goodid0002", name: "<img src=x onerror=alert(1)>.json", size: "10", modifiedTime: good(2).modified },
        { id: "goodid0003", name: good(3).name, size: "-1", modifiedTime: good(3).modified },
        { id: "goodid0004", name: good(4).name, size: "1e30", modifiedTime: good(4).modified },
        { id: "goodid0005", name: good(5).name, size: "10", modifiedTime: "not a date" },
        { id: "../../../etc", name: good(6).name, size: "10", modifiedTime: good(6).modified },
        { id: 7, name: good(7).name, size: "10", modifiedTime: good(7).modified },
        { id: "goodid0008", name: good(8).name, size: "NaN", modifiedTime: good(8).modified },
        null, "x", 5,
      ],
    },
  });
  assert.deepEqual((await gdriveTarget(sess(), gd.http).list()).map((x) => x.id), ["goodid0001"]);
  // OneDrive
  const od = fakeOnedrive({
    listBody: {
      value: [
        { id: "A1!1", name: good(1).name, size: 10, lastModifiedDateTime: good(1).modified },
        { id: "A2!2", name: "<b>x</b>.json", size: 10, lastModifiedDateTime: good(2).modified },
        { id: "A3!3", name: good(3).name, size: -1, lastModifiedDateTime: good(3).modified },
        { id: "A4!4", name: good(4).name, size: 1e30, lastModifiedDateTime: good(4).modified },
        { id: "A5!5", name: good(5).name, size: 10, lastModifiedDateTime: "garbage" },
        { id: "A6!6", name: good(6).name, size: 10, lastModifiedDateTime: good(6).modified, folder: {} },
        { id: "a b", name: good(7).name, size: 10, lastModifiedDateTime: good(7).modified },
      ],
    },
  });
  assert.deepEqual((await onedriveTarget(sess(), od.http).list()).map((x) => x.id), ["A1!1"]);
  // pCloud
  const pc = fakePcloud({
    contents: [
      { fileid: 11, name: good(1).name, size: 10, modified: "Sun, 01 Nov 2026 00:00:00 +0000", isfolder: false },
      { fileid: 12, name: "<script>.json", size: 10, modified: "Sun, 01 Nov 2026 00:00:00 +0000" },
      { fileid: 13, name: good(3).name, size: -1, modified: "Sun, 01 Nov 2026 00:00:00 +0000" },
      { fileid: 14, name: good(4).name, size: 1e30, modified: "Sun, 01 Nov 2026 00:00:00 +0000" },
      { fileid: -1, name: good(5).name, size: 10, modified: "Sun, 01 Nov 2026 00:00:00 +0000" },
      { fileid: "15", name: good(6).name, size: 10, modified: "Sun, 01 Nov 2026 00:00:00 +0000" },
      { fileid: 16, name: good(7).name, size: 10, modified: "nope" },
      { fileid: 17, name: good(8).name, size: 10, modified: "Sun, 01 Nov 2026 00:00:00 +0000", isfolder: true },
    ],
  });
  assert.deepEqual((await pcloudTarget(sess({ apiHost: "api.pcloud.com" }), pc.http).list()).map((x) => x.id), ["11"]);
  // a response with the wrong shape is an http error, not a crash
  const t = gdriveTarget(sess(), async () => ({ status: 200, headers: {}, text: "<html>" }));
  await assert.rejects(t.list(), (e) => e.code === "http");
  const t2 = gdriveTarget(sess(), async () => json(200, { files: "nope" }));
  await assert.rejects(t2.list(), (e) => e.code === "http");
});

test("multipartBody is CRLF multipart (RFC 2046) and refuses injection", () => {
  const b = "BOUNDARY12345678";
  const out = multipartBody([{ headers: { "Content-Disposition": 'form-data; name="file"; filename="a.json"', "Content-Type": "application/json" }, body: "{}" }], b);
  assert.equal(
    out,
    '--BOUNDARY12345678\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{}\r\n--BOUNDARY12345678--\r\n',
  );
  const two = multipartBody([{ headers: { A: "1" }, body: "x" }, { headers: { B: "2" }, body: "y" }], b);
  assert.equal(two.split("--" + b + "\r\n").length, 3);
  assert.throws(() => multipartBody([{ headers: { A: "1\r\nX: y" }, body: "x" }], b), (e) => e.code === "format");
  assert.throws(() => multipartBody([{ headers: {}, body: "a--" + b }], b), (e) => e.code === "format");
  assert.throws(() => multipartBody([{ headers: {}, body: "x" }], "bad boundary"), (e) => e.code === "format");
});

test("an empty token is a session error and sends nothing", async () => {
  const f = fakeGdrive();
  await assert.rejects(gdriveTarget({ token: "", expiresAt: null }, f.http).list(), (e) => e.code === "session");
  assert.equal(f.reqs.length, 0);
});
