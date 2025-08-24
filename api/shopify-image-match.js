// /api/shopify-image-match.js
// Environment Variables Diagnostic Version

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
    console.log('=== Environment Variables Diagnostic ===');
    
    // Check all environment variables
    const envCheck = {
      SHOPIFY_API_KEY: {
        exists: !!process.env.SHOPIFY_API_KEY,
        length: process.env.SHOPIFY_API_KEY ? process.env.SHOPIFY_API_KEY.length : 0,
        preview: process.env.SHOPIFY_API_KEY ? process.env.SHOPIFY_API_KEY.substring(0, 8) + '...' : 'NOT_SET'
      },
      SHOPIFY_API_PASSWORD: {
        exists: !!process.env.SHOPIFY_API_PASSWORD,
        length: process.env.SHOPIFY_API_PASSWORD ? process.env.SHOPIFY_API_PASSWORD.length : 0,
        preview: process.env.SHOPIFY_API_PASSWORD ? process.env.SHOPIFY_API_PASSWORD.substring(0, 8) + '...' : 'NOT_SET'
      },
      GOOGLE_CLOUD_CREDENTIALS: {
        exists: !!process.env.GOOGLE_CLOUD_CREDENTIALS,
        length: process.env.GOOGLE_CLOUD_CREDENTIALS ? process.env.GOOGLE_CLOUD_CREDENTIALS.length : 0,
        isValidJSON: false
      }
    };

    // Test Google Cloud JSON parsing
    if (process.env.GOOGLE_CLOUD_CREDENTIALS) {
      try {
        const parsed = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS);
        envCheck.GOOGLE_CLOUD_CREDENTIALS.isValidJSON = true;
        envCheck.GOOGLE_CLOUD_CREDENTIALS.projectId = parsed.project_id;
      } catch (e) {
        envCheck.GOOGLE_CLOUD_CREDENTIALS.parseError = e.message;
      }
    }

    console.log('Environment check:', JSON.stringify(envCheck, null, 2));

    // Return diagnostic info
    const response = {
      message: 'Environment Variables Diagnostic',
      timestamp: new Date().toISOString(),
      environment: envCheck,
      allEnvVars: Object.keys(process.env).filter(key => 
        key.includes('SHOPIFY') || key.includes('GOOGLE') || key.includes('VERCEL')
      ),
      nodeVersion: process.version,
      platform: process.platform
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Diagnostic error:', error);
    return res.status(500).json({
      error: 'Diagnostic failed',
      message: error.message,
      stack: error.stack
    });
  }
};
