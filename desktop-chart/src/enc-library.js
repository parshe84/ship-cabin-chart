'use strict';

// Library of imported S-57 ENC cells. Each cell is converted once (in a worker thread) to
// GeoJSON in <data>/enc/<cell>.json; enc/index.json lists the cells with their extent and band.
// Sources: single .000 files (updates .001… next to them are picked up), folders such as an
// ENC_ROOT exchange set, and .zip archives as distributed by hydrographic offices.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { unzipSync } = require('fflate');
const { convertCell } = require('./enc-convert');

const CELL_EXT = /\.(\d{3})$/;
const MAX_FILE = 64 * 1024 * 1024;

class EncLibrary {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      this.index = { cells: {} };
    }
  }

  list() {
    return Object.values(this.index.cells).sort((a, b) => a.band - b.band || a.name.localeCompare(b.name));
  }

  load(name) {
    if (!this.index.cells[name]) throw new Error(`Unknown chart ${name}`);
    return fs.promises.readFile(path.join(this.dir, `${name}.json`), 'utf8');
  }

  remove(names) {
    for (const n of names) {
      if (!this.index.cells[n]) continue;
      delete this.index.cells[n];
      fs.rmSync(path.join(this.dir, `${n}.json`), { force: true });
    }
    this._save();
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index));
  }

  // Groups source files into cells: { NAME: { base: {name, read()}, updates: [...] } }.
  async collect(paths) {
    const cells = {};
    const add = (file, read) => {
      const m = CELL_EXT.exec(file);
      if (!m) return;
      const stem = path.basename(file).replace(CELL_EXT, '').toUpperCase();
      const cell = (cells[stem] ||= { name: stem, base: null, updates: [] });
      if (m[1] === '000') cell.base = read;
      else cell.updates.push(read);
    };
    const walk = async (p, depth) => {
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) {
        if (depth > 6) return;
        for (const e of await fs.promises.readdir(p)) await walk(path.join(p, e), depth + 1);
      } else if (/\.zip$/i.test(p)) {
        if (st.size > 1024 * 1024 * 1024) throw new Error(`${path.basename(p)} is too large`);
        const entries = unzipSync(await fs.promises.readFile(p), { filter: (f) => CELL_EXT.test(f.name) && f.originalSize < MAX_FILE });
        for (const [n, data] of Object.entries(entries)) add(n, () => Buffer.from(data));
      } else if (CELL_EXT.test(p)) {
        if (st.size > MAX_FILE) return;
        add(p, () => fs.promises.readFile(p));
        // A single .000 picks up the updates stored next to it.
        if (/\.000$/.test(p) && depth === 0) {
          const stem = path.basename(p).replace(CELL_EXT, '');
          for (const e of await fs.promises.readdir(path.dirname(p))) {
            if (e.startsWith(stem) && CELL_EXT.test(e) && !/\.000$/.test(e)) add(path.join(path.dirname(p), e), () => fs.promises.readFile(path.join(path.dirname(p), e)));
          }
        }
      }
    };
    for (const p of paths) await walk(p, 0);
    return Object.values(cells).filter((c) => c.base);
  }

  async import(paths, onProgress) {
    const cells = await this.collect(paths);
    fs.mkdirSync(this.dir, { recursive: true });
    const results = [];
    // In the packaged app the worker script is unpacked from the asar archive (see asarUnpack);
    // if a worker cannot start, cells are converted on the main thread instead.
    let worker = null;
    try {
      worker = new Worker(path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'enc-worker.js'));
      worker.on('error', () => {});
    } catch {
      worker = null;
    }
    try {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        onProgress && onProgress({ done: i, total: cells.length, name: c.name });
        try {
          const base = await c.base();
          const updates = await Promise.all(c.updates.map((u) => u()));
          const out = path.join(this.dir, `${c.name}.json`);
          let info;
          try {
            info = worker ? await convert(worker, base, updates, `${out}.tmp`) : convertCell(base, updates, `${out}.tmp`);
          } catch (err) {
            if (!err.workerFailed) throw err;
            worker = null;
            info = convertCell(base, updates, `${out}.tmp`);
          }
          const old = this.index.cells[c.name];
          if (old && (old.edition > info.edition || (old.edition === info.edition && old.update > info.update))) {
            fs.rmSync(`${out}.tmp`, { force: true });
            results.push({ name: c.name, ok: true, skipped: `the library already has edition ${old.edition} update ${old.update}` });
            continue;
          }
          fs.renameSync(`${out}.tmp`, out);
          this.index.cells[c.name] = { ...info, name: c.name, imported: new Date().toISOString() };
          results.push({ name: c.name, ok: true, edition: info.edition, update: info.update, replaced: !!old });
        } catch (err) {
          results.push({ name: c.name, ok: false, error: err.message });
        }
      }
    } finally {
      if (worker) await worker.terminate();
      this._save();
    }
    onProgress && onProgress({ done: cells.length, total: cells.length });
    return results;
  }
}

let jobId = 0;
function convert(worker, base, updates, out) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.id !== id) return;
      worker.off('message', onMessage);
      worker.off('error', onError);
      if (m.error) reject(new Error(m.error));
      else resolve(m.info);
    };
    const onError = (err) => {
      worker.off('message', onMessage);
      err.workerFailed = true;
      reject(err);
    };
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.postMessage({ id, base, updates, out });
  });
}

module.exports = { EncLibrary };
