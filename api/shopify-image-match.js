// /api/shopify-image-match.js
// Simplified test version to debug the crash

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('API called successfully');
    console.log('Environment variables check:');
    console.log('SHOPIFY_API_KEY exists:', !!process.env.SHOPIFY_API_KEY);
    console.log('SHOPIFY_API_PASSWORD exists:', !!process.env.SHOPIFY_API_PASSWORD);
    console.log('GOOGLE_CLOUD_CREDENTIALS exists:', !!process.env.GOOGLE_CLOUD_CREDENTIALS);

    // Test response without processing
    return res.status(200).json({
      message: 'API is working!',
      timestamp: new Date().toISOString(),
      method: req.method,
      hasImage: !!req.body,
      environment: {
        shopifyKey: !!process.env.SHOPIFY_API_KEY,
        shopifyPassword: !!process.env.SHOPIFY_API_PASSWORD,
        googleCredentials: !!process.env.GOOGLE_CLOUD_CREDENTIALS
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
