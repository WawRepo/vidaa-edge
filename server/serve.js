#!/usr/bin/env node
/**
 * VIDAA Edge production server.
 *
 * Serves the built Angular app over HTTPS and forwards `/api/*` to the existing
 * API server, so the TV sees a single origin (it calls `/api/*` relative, and TV
 * browsers refuse plain HTTP). This mirrors the development setup exactly: there
 * the Angular dev server proxies to the API using `proxy.conf.js`, here this file
 * does it - so `server/api-server.js` runs unmodified in both.
 *
 * Used by `npx vidaa-edge` and by the Docker image.
 *
 * Environment:
 *   PORT       port to listen on (default 443)
 *   HOST       interface to bind (default 0.0.0.0)
 *   API_PORT   internal API port (default 3000)
 *   CERT_DIR   where key.pem / cert.pem live; generated if absent
 *   STATIC_DIR built frontend, if not at dist/vidaa-edge/browser
 *   TLS        set to "false" to serve plain HTTP
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const https = require('https');
const http = require('http');
const { fork, spawnSync } = require('child_process');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PACKAGE_ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT || 443);
const HOST = process.env.HOST || '0.0.0.0';
const API_PORT = Number(process.env.API_PORT || 3000);
const TLS_ENABLED = process.env.TLS !== 'false';
const CERT_DIR = process.env.CERT_DIR || path.join(PACKAGE_ROOT, 'certs');

/**
 * Locate the built Angular output. The Nx build writes to
 * `dist/vidaa-edge/browser`; STATIC_DIR overrides it for unusual layouts.
 */
function resolveStaticDir() {
  const candidates = [
    process.env.STATIC_DIR,
    path.join(PACKAGE_ROOT, 'dist', 'vidaa-edge', 'browser'),
    path.join(process.cwd(), 'dist', 'vidaa-edge', 'browser'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }

  console.error('❌ No built frontend found. Looked in:');
  candidates.forEach((dir) => console.error(`   - ${dir}`));
  console.error('\n   Run `npm run build:prod` first, or set STATIC_DIR.\n');
  process.exit(1);
}

/**
 * Return an existing key/cert pair, generating a self-signed one on first run.
 * The certificate is deliberately not shipped in the package: a private key
 * baked into a published artifact is the same key on every machine that
 * installs it.
 */
function resolveCertificate() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  console.log(`🔐 No certificate in ${CERT_DIR} - generating a self-signed one...`);
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const baseArgs = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-days', '825',
    '-keyout', keyPath,
    '-out', certPath,
    '-subj', '/CN=vidaahub.com',
  ];
  const sanArgs = [
    '-addext',
    'subjectAltName=DNS:vidaahub.com,DNS:localhost,IP:127.0.0.1',
  ];

  // LibreSSL (the system openssl on macOS) rejects -addext, so retry without it.
  let result = spawnSync('openssl', [...baseArgs, ...sanArgs], { stdio: 'pipe' });
  if (result.status !== 0) {
    result = spawnSync('openssl', baseArgs, { stdio: 'pipe' });
  }

  if (result.error || result.status !== 0) {
    console.error('❌ Could not generate a certificate with `openssl`.');
    console.error(`   ${result.error?.message || result.stderr?.toString().trim()}`);
    console.error(
      `\n   Install openssl, or put your own key.pem and cert.pem in ${CERT_DIR},\n` +
        '   or run with TLS=false to serve plain HTTP (the TV will not accept it).\n'
    );
    process.exit(1);
  }

  fs.chmodSync(keyPath, 0o600);
  console.log(`🔐 Self-signed certificate written to ${CERT_DIR}`);
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** Start the API server as a child process, unmodified. */
function startApiServer() {
  const child = fork(path.join(__dirname, 'api-server.js'), {
    env: { ...process.env, API_PORT: String(API_PORT) },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`❌ API server exited unexpectedly (${signal || `code ${code}`}).`);
    process.exit(code || 1);
  });

  return child;
}

/** Resolve once the API server is accepting connections. */
function waitForApi(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(API_PORT, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`API server did not start on port ${API_PORT}`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

let shuttingDown = false;

async function main() {
  const staticDir = resolveStaticDir();
  const apiServer = startApiServer();
  await waitForApi();

  const app = express();

  // Proxy first, and with no body parser in front of it, so request bodies
  // stream straight through. pathFilter keeps the /api prefix intact, matching
  // proxy.conf.js in development.
  app.use(
    createProxyMiddleware({
      pathFilter: '/api',
      target: `http://127.0.0.1:${API_PORT}`,
      changeOrigin: true,
    })
  );

  app.use(
    express.static(staticDir, {
      // index.html must never be cached: it references hashed asset filenames
      // that change with every release.
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );

  // SPA fallback, so deep links like /installer render the Angular app.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  const server = TLS_ENABLED
    ? https.createServer(resolveCertificate(), app)
    : http.createServer(app);

  server.on('error', (error) => {
    if (error.code === 'EACCES' && PORT < 1024) {
      console.error(`❌ Port ${PORT} needs elevated privileges.`);
      console.error('   Either run with sudo, or use PORT=8443 and forward 443 -> 8443.\n');
    } else if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.\n`);
    } else {
      console.error(`❌ Server error: ${error.message}\n`);
    }
    apiServer.kill('SIGTERM');
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const scheme = TLS_ENABLED ? 'https' : 'http';
    console.log('\n📺 VIDAA Edge');
    console.log(`   Serving  ${staticDir}`);
    console.log(`   Listening on ${scheme}://${HOST}:${PORT}`);
    console.log(
      `   Point vidaahub.com at this host via DNS, then open ${scheme}://vidaahub.com/ on the TV.\n`
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shuttingDown = true;
      console.log('\n👋 Shutting down...');
      apiServer.kill('SIGTERM');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch((error) => {
  console.error(`❌ ${error.message}\n`);
  process.exit(1);
});
