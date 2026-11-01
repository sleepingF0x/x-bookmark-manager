// Request-body helper for the bulk item actions: {ids: [...]} with a per-call cap.
export async function readIds(request, max) {
  let body;
  try { body = await request.json(); } catch { return { error: 'invalid json' }; }
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > max || !ids.every((id) => typeof id === 'string' && /^\d{1,25}$/.test(id))) {
    return { error: `ids must be 1-${max} tweet ids` };
  }
  return { ids: [...new Set(ids)], body };
}

export const placeholders = (a) => a.map(() => '?').join(',');
