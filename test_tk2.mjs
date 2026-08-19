const TOKEN = 'kLdYPc1M4HeKo26QRY2m2UjKER2OYJ96wBX1inncfMGdlwWzHnHbJ2ixbA==';
const BASE = 'https://api.tikhub.io';
const uid = 'vietravelofficial';
async function call(path, params) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }});
  const j = await res.json().catch(()=>({}));
  const d = j?.data ?? j;
  const list = d?.aweme_list ?? d?.videos ?? [];
  return { status: res.status, listLen: Array.isArray(list)?list.length:0, has_more: d?.has_more, max_cursor: d?.max_cursor, firstId: list[0]?.aweme_id ?? list[0]?.id };
}
let cursor = 0, total = 0, page = 0;
while (page < 8) {
  const r = await call('/api/v1/tiktok/app/v3/fetch_user_post_videos', { unique_id: uid, count: 50, sort_type: 0, max_cursor: cursor });
  console.log(`page ${page}: len=${r.listLen} has_more=${r.has_more} max_cursor=${r.max_cursor} firstId=${r.firstId}`);
  total += r.listLen;
  if (!r.listLen || !r.has_more) break;
  cursor = r.max_cursor;
  page++;
}
console.log('TOTAL fetched (8 pages):', total);
