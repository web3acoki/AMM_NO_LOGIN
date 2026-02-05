// Vercel Serverless Function - FourMeme API 通用代理

export default async function handler(req, res) {
  // 获取请求路径
  const { path } = req.query;
  const apiPath = Array.isArray(path) ? path.join('/') : path;
  const targetUrl = `https://four.meme/meme-api/v1/${apiPath}`;

  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, meme-web-access');

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // 构建转发请求的 headers
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://four.meme',
      'Referer': 'https://four.meme/',
    };

    // 转发认证 headers
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }
    if (req.headers['meme-web-access']) {
      headers['meme-web-access'] = req.headers['meme-web-access'];
    }

    // 构建请求选项
    const fetchOptions = {
      method: req.method,
      headers,
    };

    // 处理请求体 (POST/PUT)
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    // 发送请求到 FourMeme
    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({
      code: -1,
      msg: `Proxy error: ${error.message}`,
      targetUrl
    });
  }
}
