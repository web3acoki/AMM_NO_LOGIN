// Vercel Serverless Function - Pons token verification proxy.

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = String(req.body?.token || '').trim();
  if (!ADDRESS_PATTERN.test(token)) return res.status(400).json({ error: 'Invalid token address' });

  try {
    const response = await fetch('https://pons.family/api/pons-verify-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://pons.family',
        'Referer': 'https://pons.family/launchpad/create',
      },
      body: JSON.stringify({ token }),
    });
    const text = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (error) {
    console.error('Pons verification proxy error:', error);
    return res.status(502).json({ error: `Pons verification proxy error: ${error.message}` });
  }
}
