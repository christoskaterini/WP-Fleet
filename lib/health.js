import { updateSiteHealth } from './db.js';

export async function checkSiteHealth(site) {
  const url = site.site_url || `https://${site.domain}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const start = performance.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'wp-fleet-healthcheck/1.0' },
    });
    const ttfb = Math.round(performance.now() - start);
    // Drain body lightly so socket closes cleanly
    await res.arrayBuffer().catch(() => {});

    const result = {
      http_status: res.status,
      ttfb_ms: ttfb,
      health_error: res.status >= 400 ? `HTTP ${res.status}` : '',
    };
    updateSiteHealth(site.domain, result);
    return result;
  } catch (err) {
    const ttfb = Math.round(performance.now() - start);
    const detail = err.cause?.code ? `${err.cause.code} (${err.cause.hostname || ''})` : err.message;
    const result = {
      http_status: 0,
      ttfb_ms: ttfb,
      health_error: err.name === 'AbortError' ? 'Timeout (10s)' : detail,
    };
    updateSiteHealth(site.domain, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
