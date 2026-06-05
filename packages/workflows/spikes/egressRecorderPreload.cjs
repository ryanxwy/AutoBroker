/**
 * SPIKE-6 — process-level egress recorder (CommonJS preload).
 *
 * Loaded via `node --require` / `NODE_OPTIONS=--require` BEFORE any application
 * (or vitest worker) code runs, so the monkey-patches are in place before
 * @mastra/* boots. It records every outbound network attempt — DNS resolution,
 * raw TCP connect, TLS connect, and global fetch — as one JSON line per event
 * appended to the file named by env EGRESS_LOG.
 *
 * SCOPE (honest): this is PROCESS-LEVEL, not wire-level. It proves the app made
 * no *attempt* to open a remote connection from JS. It cannot see traffic that
 * bypasses these Node APIs (native addons opening their own sockets, a
 * pre-resolved IP handed straight to libuv outside net.Socket, etc.). True
 * wire-level proof needs tcpdump/pktap (sudo) — unavailable in this sandbox.
 * undici (Node 22 global fetch) IS covered: we patch globalThis.fetch, and its
 * underlying connects also surface through net.Socket/tls.connect patches.
 *
 * The patches always CALL THROUGH to the originals — recording is passive and
 * must never change behaviour (localhost / file: DB ops still work normally).
 */

"use strict";

const fs = require("node:fs");
const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");

const LOG = process.env.EGRESS_LOG;

/** Append one event record as a JSON line. Never throws into the callee. */
function record(kind, detail) {
  if (!LOG) return;
  try {
    const line =
      JSON.stringify({ kind, t: Date.now(), ...detail }) + "\n";
    fs.appendFileSync(LOG, line);
  } catch {
    // Recording must never break the patched call.
  }
}

// Marker proves the preload was actually armed in THIS process before any
// app code ran. The parent asserts on its presence.
record("preload-armed", { pid: process.pid });

// --- dns.lookup -----------------------------------------------------------
const origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  record("dns.lookup", { hostname: String(hostname) });
  return origLookup.call(this, hostname, ...rest);
};

// --- dns.promises.lookup / resolve* --------------------------------------
if (dns.promises) {
  const p = dns.promises;
  const origPLookup = p.lookup;
  p.lookup = function patchedPromiseLookup(hostname, ...rest) {
    record("dns.promises.lookup", { hostname: String(hostname) });
    return origPLookup.call(this, hostname, ...rest);
  };
  for (const fn of ["resolve", "resolve4", "resolve6", "resolveAny"]) {
    if (typeof p[fn] === "function") {
      const orig = p[fn];
      p[fn] = function patchedResolve(hostname, ...rest) {
        record("dns.promises." + fn, { hostname: String(hostname) });
        return orig.call(this, hostname, ...rest);
      };
    }
  }
}

// --- dns.resolve* (callback form) ----------------------------------------
for (const fn of ["resolve", "resolve4", "resolve6", "resolveAny"]) {
  if (typeof dns[fn] === "function") {
    const orig = dns[fn];
    dns[fn] = function patchedDnsResolve(hostname, ...rest) {
      record("dns." + fn, { hostname: String(hostname) });
      return orig.call(this, hostname, ...rest);
    };
  }
}

// --- net.Socket.prototype.connect ----------------------------------------
// Signature variants: connect(options[, cb]) / connect(port[, host][, cb]) /
// connect(path[, cb]). We extract host+port best-effort and record, but skip
// pure UNIX-socket / file-descriptor connects (no remote host) and obvious
// loopback so the "external set" stays meaningful — still record loopback
// under a separate kind for full transparency.
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  try {
    let host;
    let port;
    let path;
    const a0 = args[0];
    if (a0 && typeof a0 === "object") {
      host = a0.host;
      port = a0.port;
      path = a0.path;
    } else if (typeof a0 === "number") {
      port = a0;
      host = typeof args[1] === "string" ? args[1] : undefined;
    } else if (typeof a0 === "string") {
      // Could be a UNIX socket path or pipe.
      path = a0;
    }
    record("net.connect", {
      host: host !== undefined ? String(host) : null,
      port: port !== undefined ? Number(port) : null,
      path: path !== undefined ? String(path) : null,
    });
  } catch {
    record("net.connect", { host: null, port: null, path: null });
  }
  return origConnect.apply(this, args);
};

// --- tls.connect ----------------------------------------------------------
const origTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  try {
    let host;
    let port;
    let servername;
    const a0 = args[0];
    if (a0 && typeof a0 === "object") {
      host = a0.host;
      port = a0.port;
      servername = a0.servername;
    } else if (typeof a0 === "number") {
      port = a0;
      host = typeof args[1] === "string" ? args[1] : undefined;
    }
    record("tls.connect", {
      host: host !== undefined ? String(host) : null,
      port: port !== undefined ? Number(port) : null,
      servername: servername !== undefined ? String(servername) : null,
    });
  } catch {
    record("tls.connect", { host: null, port: null, servername: null });
  }
  return origTlsConnect.apply(this, args);
};

// --- globalThis.fetch (undici) -------------------------------------------
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    try {
      let url;
      if (typeof input === "string") url = input;
      else if (input && typeof input === "object" && "url" in input)
        url = input.url;
      else url = String(input);
      let host = null;
      try {
        host = new URL(url).hostname;
      } catch {
        host = null;
      }
      record("fetch", { url: String(url), host });
    } catch {
      record("fetch", { url: null, host: null });
    }
    return origFetch.call(this, input, init);
  };
}
