/**
 * API bridge — detects Electron vs browser and routes calls accordingly.
 * In Electron: uses IPC to main process (no Express server needed).
 * In browser: uses fetch to Express server at /api/*.
 */

const GGG_BASE = 'https://www.pathofexile.com';
export const isElectron = !!window.electronAPI;

export async function getConfig() {
  if (isElectron) return window.electronAPI.getConfig();
  const res = await fetch('/api/config');
  return res.json();
}

export async function login() {
  if (isElectron) return window.electronAPI.login();
  await fetch('/api/login', { method: 'POST' });
  return { ok: true };
}

export async function logout() {
  if (isElectron) return window.electronAPI.logout();
  await fetch('/api/logout', { method: 'POST' });
  return { ok: true };
}

export function onLoginState(cb) {
  if (isElectron) window.electronAPI.onLoginState(cb);
}

/**
 * Fetch from the PoE trade API.
 * In Electron: IPC → main process net.request (has session cookies).
 * In browser: fetch to /api/trade/* proxy (Express → Puppeteer Chrome).
 */
export async function tradeFetch(path, options = {}) {
  if (isElectron) {
    const url = `${GGG_BASE}${path}`;
    const result = await window.electronAPI.tradeFetch({
      url,
      method: options.method || 'GET',
      body: options.body || null,
    });
    // Mimic a fetch Response
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: () => Promise.resolve(JSON.parse(result.body)),
      text: () => Promise.resolve(result.body),
      headers: { get: (k) => k === 'content-type' ? result.contentType : null },
    };
  }
  // Browser: proxy through Express
  return fetch(path, options);
}
