// The slice of the Workers AI binding the app uses (text embeddings), called over Cloudflare's
// OpenAI-compatible REST endpoint so the Docker edition uses the very same model as the Worker.
// Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with "Workers AI: Read" permission.
export function workersAI(accountId, token) {
  return {
    async run(model, { text }) {
      if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });
      if (!r.ok) throw new Error(`Workers AI ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const { data } = await r.json();
      return { data: data.sort((a, b) => a.index - b.index).map((d) => d.embedding) };
    },
  };
}
