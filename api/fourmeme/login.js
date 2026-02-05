// Vercel Serverless Function - FourMeme 登录

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const response = await fetch('https://four.meme/meme-api/v1/private/user/login/dex', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://four.meme',
        'Referer': 'https://four.meme/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ code: -1, msg: error.message });
  }
}
