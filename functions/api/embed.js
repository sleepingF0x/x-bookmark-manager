// Query embedding for semantic search; must use the same model as scripts/embed.py.
const MODEL = '@cf/baai/bge-m3';

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 200);
  if (!q) return Response.json({ error: 'missing q' }, { status: 400 });
  const { data } = await env.AI.run(MODEL, { text: [q] });
  return Response.json({ model: MODEL, vector: data[0] });
}
