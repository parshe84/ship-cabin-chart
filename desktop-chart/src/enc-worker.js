'use strict';

// Runs convertCell off the main thread so a large import does not freeze the window.

const { parentPort } = require('worker_threads');
const { convertCell } = require('./enc-convert');

parentPort.on('message', ({ id, base, updates, out }) => {
  try {
    parentPort.postMessage({ id, info: convertCell(base, updates, out) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
