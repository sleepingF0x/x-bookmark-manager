// The whole library for the site: every item's JSON plus its accession number, X status, bin state
// and base64 int8 embedding, newest bookmark first. SQLite assembles each row so the Worker only joins strings.
export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT json_set(data, '$.no', no, '$.bookmarked', bookmarked, '$.pending', pending, '$.trashed', trashed_at,
       '$.kept', kept, '$.vec', vec) AS j
     FROM items ORDER BY no DESC`).all();
  return new Response(`{"items":[${results.map((r) => r.j).join(',')}]}`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
