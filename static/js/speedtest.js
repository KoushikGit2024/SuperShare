import { deviceHeaders } from "./services/device.js";
import { sha256Buf } from "./services/utils.js";

const MIB = 1024 * 1024;
const out = document.getElementById("out");
const log = (line) => {
  out.textContent += `\n${line}`;
};
const rate = (bytes, ms) => `${(bytes / MIB / (ms / 1000)).toFixed(2)} MB/s`;

async function testHash() {
  const buf = new ArrayBuffer(4 * MIB);
  const n = 8;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await sha256Buf(buf);
  log(
    `client SHA-256 (${globalThis.crypto?.subtle ? "native" : "JS fallback"}): ${rate(n * 4 * MIB, performance.now() - t0)}`
  );
}

async function testDown() {
  const t0 = performance.now();
  let got = 0;
  const response = await fetch("/api/speedtest-down?mb=64", {
    headers: deviceHeaders(),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`download test failed (${response.status})`);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
  }
  log(`download 64 MiB: ${rate(got, performance.now() - t0)}`);
}

async function post(mb) {
  const response = await fetch("/api/speedtest-up", {
    method: "POST",
    headers: deviceHeaders(),
    credentials: "same-origin",
    body: new Blob([new Uint8Array(mb * MIB)]),
  });
  if (!response.ok) throw new Error(`upload test failed (${response.status})`);
  return response.json();
}

async function testUp() {
  let t0 = performance.now();
  await post(32);
  log(`upload, 1 stream, 32 MiB: ${rate(32 * MIB, performance.now() - t0)}`);
  t0 = performance.now();
  await Promise.all([post(16), post(16), post(16)]);
  log(`upload, 3 streams, 48 MiB: ${rate(48 * MIB, performance.now() - t0)}`);
}

async function testRead(file) {
  if (!file) return log("file read: pick a file first");
  const chunks = Math.min(8, Math.ceil(file.size / (4 * MIB)));
  let bytes = 0;
  const t0 = performance.now();
  for (let i = 0; i < chunks; i++) {
    bytes += (await file.slice(i * 4 * MIB, (i + 1) * 4 * MIB).arrayBuffer()).byteLength;
  }
  log(`file read (slice+arrayBuffer): ${rate(bytes, performance.now() - t0)}`);
}

document.getElementById("run").addEventListener("click", async () => {
  out.textContent = "Running…";
  log(
    `isSecureContext=${window.isSecureContext}  crypto.subtle=${Boolean(globalThis.crypto?.subtle)}`
  );
  log(`UA: ${navigator.userAgent}`);
  log(`effectiveType: ${navigator.connection?.effectiveType || "n/a"}`);
  for (const step of [
    testHash,
    testDown,
    testUp,
    () => testRead(document.getElementById("file").files[0]),
  ]) {
    try {
      await step();
    } catch (error) {
      log(`ERROR: ${error.message}`);
    }
  }
  log(`Timings from last real upload: ${JSON.stringify(window.xferStats || "none yet")}`);
});
