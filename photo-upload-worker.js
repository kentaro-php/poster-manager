/**
 * Cloudflare Worker: ポスター写真アップロード
 *
 * R2バケットへの直接アップロードを処理し、公開URLを返す。
 *
 * 設定方法:
 * 1. Cloudflare Dashboard > Workers & Pages > Create
 * 2. このコードを貼り付けデプロイ
 * 3. R2バケットを作成: poster-photos
 * 4. Worker > Settings > Bindings > Add Binding
 *    - Type: R2 Bucket
 *    - Variable name: PHOTOS
 *    - R2 bucket: poster-photos
 * 5. R2バケットの設定で「公開アクセス」を有効化（Custom domain or r2.dev）
 *
 * フロントエンドからの使い方:
 *   POST {worker-url}/upload
 *   Content-Type: image/jpeg
 *   Body: <画像バイナリ>
 *   ↓
 *   { url: "https://pub-xxx.r2.dev/yyyy.jpg" }
 */

// 公開R2バケットのベースURL（ご自身のR2公開URLに置き換える）
// 例: 'https://pub-abc123.r2.dev' または 'https://photos.example.com'
const PUBLIC_BASE_URL = 'https://YOUR_R2_PUBLIC_DOMAIN';

const ALLOWED_ORIGINS = [
  'https://kentaro-php.github.io',
  'https://dspartners.jp',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
];

const MAX_SIZE = 8 * 1024 * 1024; // 8MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Poster-Id',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function generateKey(posterId) {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 10);
  const safeId = (posterId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `posters/${ymd}/${safeId}_${rand}.jpg`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // ヘルプ画面
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({
        ok: true,
        message: 'ポスター写真アップロード Worker',
        usage: 'POST /upload (Content-Type: image/jpeg, body: binary)',
        publicBase: PUBLIC_BASE_URL,
      }, null, 2), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // POST /upload
    if (request.method === 'POST' && url.pathname === '/upload') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        if (!ALLOWED_TYPES.some(t => contentType.startsWith(t))) {
          return new Response(JSON.stringify({
            error: 'Unsupported content-type',
            allowed: ALLOWED_TYPES
          }), {
            status: 400,
            headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }

        const contentLength = parseInt(request.headers.get('Content-Length') || '0');
        if (contentLength > MAX_SIZE) {
          return new Response(JSON.stringify({
            error: 'File too large',
            max: MAX_SIZE
          }), {
            status: 413,
            headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }

        const posterId = request.headers.get('X-Poster-Id') || 'unknown';
        const key = generateKey(posterId);

        // R2にアップロード
        if (!env.PHOTOS) {
          throw new Error('R2 binding "PHOTOS" not configured');
        }

        await env.PHOTOS.put(key, request.body, {
          httpMetadata: { contentType },
        });

        const publicUrl = `${PUBLIC_BASE_URL}/${key}`;

        return new Response(JSON.stringify({
          success: true,
          url: publicUrl,
          key,
        }), {
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({
          error: 'Upload failed',
          message: String(e),
        }), {
          status: 500,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404, headers });
  },
};
