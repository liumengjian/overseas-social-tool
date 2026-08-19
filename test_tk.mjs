const TOKEN = 'kLdYPc1M4HeKo26QRY2m2UjKER2OYJ96wBX1inncfMGdlwWzHnHbJ2ixbA==';
const BASE = 'https://api.tikhub.io';
const uid = 'vietravelofficial';

async function call(path, params) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }});
  const raw = await res.text();
  let j; try { j = JSON.parse(raw); } catch { return { status: res.status, raw: raw.slice(0,300) }; }
  const d = j?.data ?? j;
  const list = d?.videos ?? d?.aweme_list ?? d?.item_list ?? (d?.aweme_detail?[d.aweme_detail]:[]);
  return { status: res.status, code: j?.code, listLen: Array.isArray(list)?list.length:0, hasMore: d?.has_more ?? d?.hasMore, cursor: d?.max_cursor ?? d?.cursor, keys: Object.keys(d||{}).slice(0,20) };
}

console.log('--- App V3 count=50 ---');
console.log(JSON.stringify(await call('/api/v1/tiktok/app/v3/fetch_user_post_videos', { unique_id: uid, count: 50, sort_type: 0 }), null, 1));
console.log('--- App V3 count=10 ---');
console.log(JSON.stringify(await call('/api/v1/tiktok/app/v3/fetch_user_post_videos', { unique_id: uid, count: 10, sort_type: 0 }), null, 1));
console.log('--- Web fetch_user_post count=50 ---');
console.log(JSON.stringify(await call('/api/v1/tiktok/web/fetch_user_post', { unique_id: uid, count: 50, sort_type: 0 }), null, 1));
