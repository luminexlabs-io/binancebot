const { log } = require('./logger');

// Binance Square OpenAPI (official, key from the Square Creator Center).
// Contract mirrors Binance's own binance-skills-hub square-post scripts:
//   POST v2 /image/presignedUrl -> PUT file to S3 -> POST v2 /image/imageStatus
//   POST v1 /content/add        -> contentType 1 = short post with imageList
const V2 = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const V1 = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';

class SquareApiError extends Error {
  constructor(code, message) {
    super(`Square API ${code}: ${message}`);
    this.code = String(code);
  }
}

const ERROR_HINTS = {
  220003: 'API key not found - check BINANCE_SQUARE_OPENAPI_KEY',
  220004: 'API key expired - create a new one at binance.com/square/creator-center/home',
  220009: 'daily post limit reached (100/day)',
  220014: 'daily upload limit reached (400/day)',
  20002: 'sensitive words detected in content',
  20022: 'sensitive words detected in content',
  20013: 'content too long',
  20020: 'empty content body',
  220011: 'empty content body',
  30008: 'account/device posting restriction',
  2000001: 'account/device posting restriction',
  2000002: 'account/device posting restriction',
};

function baseHeaders(apiKey) {
  return {
    'X-Square-OpenAPI-Key': apiKey,
    'Content-Type': 'application/json',
    clienttype: 'binanceSkill',
  };
}

async function call(apiKey, baseUrl, endpoint, body, timeoutMs = 30000) {
  const res = await fetch(baseUrl + endpoint, {
    method: 'POST',
    headers: baseHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 504) {
    // Documented behavior: the post is usually created even when this happens.
    throw new SquareApiError('HTTP_504', 'gateway timeout after submission');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.code !== '000000') {
    const hint = ERROR_HINTS[json.code] ? ` (${ERROR_HINTS[json.code]})` : '';
    throw new SquareApiError(json.code, `${json.message || 'unknown error'}${hint}`);
  }
  return json.data;
}

// Returns the processed CDN image URL.
async function uploadImage(apiKey, imageBuffer, filename = 'chart.png') {
  const contentType = /\.(jpe?g)$/i.test(filename) ? 'image/jpeg' : 'image/png';

  const pre = await call(apiKey, V2, '/image/presignedUrl', { imageName: filename });
  const uploadUrl = pre.presignedUrl || pre.url || pre.uploadUrl;
  const fileTicket = pre.fileTicket || pre.ticket;
  if (!uploadUrl || !fileTicket) {
    throw new Error(`presignedUrl response missing fields: ${JSON.stringify(pre).slice(0, 300)}`);
  }

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: imageBuffer,
    signal: AbortSignal.timeout(60000),
  });
  if (!put.ok) throw new Error(`image upload to storage failed: HTTP ${put.status}`);

  for (let attempt = 1; attempt <= 10; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await call(apiKey, V2, '/image/imageStatus', { fileTicket });
    if (status.status === 1 && status.imageUrl) return status.imageUrl;
    if (status.status === 2) {
      throw new Error(`image processing failed: ${status.failedReason || 'unknown reason'}`);
    }
  }
  throw new Error('image processing timed out after 10 attempts');
}

async function publishPost(apiKey, { text, imageUrls = [] }) {
  const body = { contentType: 1, bodyTextOnly: text };
  if (imageUrls.length) body.imageList = imageUrls;

  try {
    const data = await call(apiKey, V1, '/content/add', body, 60000);
    const id = data?.id || null;
    return { id, link: data?.shareLink || (id ? `https://www.binance.com/square/post/${id}` : null) };
  } catch (err) {
    if (err instanceof SquareApiError && err.code === 'HTTP_504') {
      log('square: 504 from /content/add - post was likely created (no id returned)');
      return { id: null, link: null, publishStatus: 'success_without_post_id' };
    }
    throw err;
  }
}

module.exports = { uploadImage, publishPost, SquareApiError };
