/*
 * Lagring i en vanlig mapp (File System Access API, Edge/Chrome).
 * Mappen ligger i ett SharePoint-bibliotek som synkas med OneDrive.
 *
 * Struktur i datamappen:
 *   changes/<id>.json      en fil per ändring (inkl. historik)
 *   processes/<id>.json    en fil per process
 *   techlog/<id>.json      en fil per loggboksanteckning
 *   settings/app.json      gemensamma inställningar
 *   images/<fil>           bilder
 *   backup/                säkerhetskopior
 *
 * Allt hamnar i namnrymden window.AL (Storage är redan ett inbyggt namn i webbläsaren).
 */
(function (global) {
  'use strict';

  var POLL_MS = 10000;
  var FOLDERS = ['changes', 'processes', 'techlog', 'settings', 'images', 'backup'];

  // ---------- IndexedDB: kom ihåg vald mapp mellan besök ----------
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('andringslogg', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('handles'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbOp(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('handles', mode), st = tx.objectStore('handles'), rq = fn(st);
        tx.oncomplete = function () { res(rq && rq.result); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isNotFound(e) { return e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError'); }

  // ---------- Samling (en undermapp med JSON-filer) ----------
  function Collection(db, name) {
    this.db = db; this.name = name;
    this.cache = {}; this.subs = []; this.loaded = false; this.busy = false;
  }
  Collection.prototype.snapshot = function () {
    var self = this, ids = Object.keys(this.cache).sort();
    var docs = ids.map(function (id) {
      return { id: id, exists: true, data: function () { return clone(self.cache[id].data); } };
    });
    return { docs: docs, size: docs.length, empty: !docs.length };
  };
  Collection.prototype.all = function () {
    var o = {}, self = this;
    Object.keys(this.cache).forEach(function (id) { o[id] = clone(self.cache[id].data); });
    return o;
  };
  Collection.prototype.emit = function () {
    var snap = this.snapshot();
    this.subs.slice().forEach(function (s) { try { s.next(snap); } catch (e) { console.error(e); } });
  };
  Collection.prototype.poll = async function () {
    if (this.busy) return;
    this.busy = true;
    try {
      var dir = await this.db.dir(this.name), seen = {}, changed = false;
      for await (var entry of dir.entries()) {
        var name = entry[0], h = entry[1];
        if (h.kind !== 'file' || !/\.json$/i.test(name)) continue;
        var id = name.replace(/\.json$/i, ''); seen[id] = 1;
        var f = await h.getFile(), sig = f.lastModified + ':' + f.size, c = this.cache[id];
        if (!c || c.sig !== sig) {
          try { this.cache[id] = { sig: sig, data: JSON.parse(await f.text()) }; changed = true; }
          catch (e) { /* filen kan vara halvsynkad, försök igen vid nästa runda */ }
        }
      }
      var self = this;
      Object.keys(this.cache).forEach(function (k) { if (!seen[k]) { delete self.cache[k]; changed = true; } });
      if (changed || !this.loaded) { this.loaded = true; this.emit(); }
      this.db.lastPoll = new Date();
    } catch (e) {
      this.subs.slice().forEach(function (s) { if (s.error) s.error(e); });
    } finally { this.busy = false; }
  };
  Collection.prototype.onSnapshot = function (next, error) {
    var sub = { next: next, error: error }, self = this;
    this.subs.push(sub);
    if (this.loaded) setTimeout(function () { next(self.snapshot()); }, 0); else this.poll();
    return function () { self.subs = self.subs.filter(function (s) { return s !== sub; }); };
  };
  Collection.prototype.get = async function () { await this.poll(); return this.snapshot(); };
  Collection.prototype.doc = function (id) { return new Doc(this.db, this, id); };
  Collection.prototype.add = async function (data) {
    var d = this.doc(rid()); await d.set(data); return d;
  };

  // ---------- Dokument (en JSON-fil) ----------
  function Doc(db, col, id) { this.db = db; this.col = col; this.id = id; }
  Doc.prototype.fileName = function () { return this.id + '.json'; };
  Doc.prototype.get = async function () {
    var id = this.id;
    try {
      var d = await this.db.dir(this.col.name), fh = await d.getFileHandle(this.fileName());
      var f = await fh.getFile(), data = JSON.parse(await f.text());
      return { id: id, exists: true, data: function () { return clone(data); } };
    } catch (e) {
      if (isNotFound(e)) return { id: id, exists: false, data: function () { return undefined; } };
      throw e;
    }
  };
  Doc.prototype.exists = async function () { return (await this.get()).exists; };
  Doc.prototype.set = async function (data) {
    var d = await this.db.dir(this.col.name), text = JSON.stringify(data), err;
    for (var i = 0; i < 4; i++) {
      try {
        var fh = await d.getFileHandle(this.fileName(), { create: true });
        var w = await fh.createWritable(); await w.write(text); await w.close();
        var f = await fh.getFile();
        this.col.cache[this.id] = { sig: f.lastModified + ':' + f.size, data: clone(data) };
        this.col.emit();
        return;
      } catch (e) { err = e; if (e && e.name === 'NotAllowedError') break; await sleep(400 * (i + 1)); }
    }
    throw err;
  };
  Doc.prototype.update = async function (patch) {
    var cur = await this.get(); await this.set(Object.assign({}, cur.exists ? cur.data() : {}, patch));
  };
  Doc.prototype.delete = async function () {
    var d = await this.db.dir(this.col.name);
    try { await d.removeEntry(this.fileName()); } catch (e) { if (!isNotFound(e)) throw e; }
    delete this.col.cache[this.id]; this.col.emit();
  };
  Doc.prototype.onSnapshot = function (next, error) {
    var id = this.id;
    return this.col.onSnapshot(function (snap) {
      var hit = snap.docs.filter(function (d) { return d.id === id; })[0];
      next(hit || { id: id, exists: false, data: function () { return undefined; } });
    }, error);
  };

  // ---------- Databasen (hela datamappen) ----------
  function FileDB(root) {
    this.root = root; this.dirs = {}; this.cols = {}; this.urls = {}; this.lastPoll = null; this.timer = null;
  }
  FileDB.prototype.dir = async function (name) {
    if (!this.dirs[name]) this.dirs[name] = await this.root.getDirectoryHandle(name, { create: true });
    return this.dirs[name];
  };
  FileDB.prototype.init = async function () {
    for (var i = 0; i < FOLDERS.length; i++) await this.dir(FOLDERS[i]);
    try { await this.root.getFileHandle('_andringslogg.json'); }
    catch (e) {
      var fh = await this.root.getFileHandle('_andringslogg.json', { create: true });
      var w = await fh.createWritable();
      await w.write(JSON.stringify({ app: 'andringslogg', format: 1, created: new Date().toISOString() }));
      await w.close();
    }
  };
  FileDB.prototype.collection = function (name) {
    if (!this.cols[name]) this.cols[name] = new Collection(this, name);
    return this.cols[name];
  };
  FileDB.prototype.doc = function (path) {
    var p = path.split('/'); return this.collection(p[0]).doc(p[1]);
  };
  FileDB.prototype.pollAll = function () {
    var self = this;
    return Promise.all(Object.keys(this.cols).map(function (k) {
      return self.cols[k].subs.length ? self.cols[k].poll() : null;
    }));
  };
  FileDB.prototype.startPolling = function () {
    var self = this;
    if (this.timer) return;
    this.timer = setInterval(function () { if (!document.hidden) self.pollAll(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) self.pollAll(); });
    window.addEventListener('focus', function () { self.pollAll(); });
  };
  FileDB.prototype.stopPolling = function () { clearInterval(this.timer); this.timer = null; };

  // ---------- Bilder (binärfiler) ----------
  FileDB.prototype.putFile = async function (folder, name, blob) {
    var d = await this.dir(folder), fh = await d.getFileHandle(name, { create: true });
    var w = await fh.createWritable(); await w.write(blob); await w.close();
  };
  FileDB.prototype.fileUrl = async function (folder, name) {
    var key = folder + '/' + name;
    if (this.urls[key]) return this.urls[key];
    var d = await this.dir(folder), fh = await d.getFileHandle(name), f = await fh.getFile();
    this.urls[key] = URL.createObjectURL(f);
    return this.urls[key];
  };
  FileDB.prototype.removeFile = async function (folder, name) {
    var d = await this.dir(folder);
    try { await d.removeEntry(name); } catch (e) { if (!isNotFound(e)) throw e; }
    delete this.urls[folder + '/' + name];
  };
  FileDB.prototype.listFiles = async function (folder) {
    var d = await this.dir(folder), out = [];
    for await (var e of d.entries()) if (e[1].kind === 'file') out.push(e[0]);
    return out;
  };

  // ---------- Säkerhetskopia (en JSON-fil med allt) ----------
  FileDB.prototype.backup = async function (label) {
    var self = this, out = { created: new Date().toISOString(), format: 1 };
    ['changes', 'processes', 'techlog', 'settings'].forEach(function (n) { out[n] = self.collection(n).all(); });
    var t = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = 'backup-' + t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + (label ? '-' + label : '') + '.json';
    await this.putFile('backup', name, new Blob([JSON.stringify(out)], { type: 'application/json' }));
    return name;
  };
  FileDB.prototype.hasBackupToday = async function () {
    var t = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var prefix = 'backup-' + t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
    var files = await this.listFiles('backup');
    return files.some(function (f) { return f.indexOf(prefix) === 0; });
  };

  // ---------- Val och återställning av mapp ----------
  global.AL = {
    supported: typeof global.showDirectoryPicker === 'function',
    FileDB: FileDB,
    rid: rid,
    // Returnerar {handle, permission} eller null om ingen mapp är vald sedan tidigare.
    restore: async function () {
      var h = await idbOp('readonly', function (st) { return st.get('root'); });
      if (!h) return null;
      var perm = await h.queryPermission({ mode: 'readwrite' });
      return { handle: h, permission: perm };
    },
    pick: async function () {
      var h = await global.showDirectoryPicker({ mode: 'readwrite', id: 'andringslogg' });
      await idbOp('readwrite', function (st) { return st.put(h, 'root'); });
      return h;
    },
    request: function (h) { return h.requestPermission({ mode: 'readwrite' }); },
    forget: function () { return idbOp('readwrite', function (st) { return st.delete('root'); }); }
  };
})(window);
