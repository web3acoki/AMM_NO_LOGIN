// Vercel Serverless Function - FourMeme 图片上传代理

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, meme-web-access');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ code: -1, msg: 'Method not allowed' });
    return;
  }

  try {
    // 读取原始请求体
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // 直接转发到 FourMeme
    const response = await fetch('https://four.meme/meme-api/v1/private/token/upload', {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'],
        'Content-Length': body.length.toString(),
        'Authorization': req.headers.authorization || '',
        'meme-web-access': req.headers['meme-web-access'] || '',
        'Origin': 'https://four.meme',
        'Referer': 'https://four.meme/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: body,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Upload proxy error:', error);
    res.status(500).json({
      code: -1,
      msg: `Upload proxy error: ${error.message}`,
    });
  }
}
