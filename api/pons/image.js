// Vercel Serverless Function - Pons IPFS image upload proxy.

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return res.status(415).json({ error: 'Expected multipart/form-data' });
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  // Multipart framing adds a small amount over the 5 MB image limit.
  if (declaredLength > MAX_IMAGE_BYTES + 128 * 1024) {
    return res.status(413).json({ error: 'Image must be smaller than 5 MB' });
  }

  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES + 128 * 1024) {
        return res.status(413).json({ error: 'Image must be smaller than 5 MB' });
      }
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    // Reject clearly unsupported uploads without implementing a multipart parser.
    const lowerHead = body.subarray(0, Math.min(body.length, 4096)).toString('latin1').toLowerCase();
    if (![...ALLOWED_TYPES].some((type) => lowerHead.includes(`content-type: ${type}`))) {
      return res.status(415).json({ error: 'Only PNG, JPEG, WebP, or GIF images are supported' });
    }

    const response = await fetch('https://pons.family/api/ipfs/image', {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'Origin': 'https://pons.family',
        'Referer': 'https://pons.family/launchpad/create',
      },
      body,
    });
    const text = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (error) {
    console.error('Pons image proxy error:', error);
    return res.status(502).json({ error: `Pons image proxy error: ${error.message}` });
  }
}
