// /api/shopify-image-match.js
// MINIMAL DIAGNOSTIC VERSION - Test if basic API works

export default async function handler(req, res) {
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

  try {
    console.log('=== DIAGNOSTIC API STARTED ===');
    console.log('Method:', req.method);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    
    // Check if this is even running
    const diagnosticData = {
      status: 'API is running!',
      method: req.method,
      timestamp: new Date().toISOString(),
      node_version: process.version,
      environment: process.env.NODE_ENV || 'unknown'
    };

    // Check environment variables
    const shopifyVars = {};
    Object.keys(process.env).forEach(key => {
      if (key.includes('SHOPIFY')) {
        shopifyVars[key] = {
          exists: !!process.env[key],
          preview: process.env[key] ? process.env[key].substring(0, 10) + '...' : 'undefined'
        };
      }
    });
    
    diagnosticData.shopify_env_vars = shopifyVars;
    diagnosticData.all_env_var_count = Object.keys(process.env).length;
    
    // Test if we can require basic modules
    try {
      require('multiparty');
      diagnosticData.multiparty_available = true;
    } catch (e) {
      diagnosticData.multiparty_available = false;
      diagnosticData.multiparty_error = e.message;
    }

    // Only try POST-specific logic if it's a POST request
    if (req.method === 'POST') {
      try {
        // Try to parse form data
        const multiparty = require('multiparty');
        const form = new multiparty.Form();
        
        const formData = await new Promise((resolve, reject) => {
          form.parse(req, (err, fields, files) => {
            if (err) {
              reject(err);
              return;
            }
            resolve({ fields, files });
          });
        });
        
        diagnosticData.form_parsing = 'success';
        diagnosticData.received_fields = Object.keys(formData.fields);
        diagnosticData.received_files = Object.keys(formData.files);
        
      } catch (formError) {
        diagnosticData.form_parsing = 'failed';
        diagnosticData.form_error = formError.message;
      }
    }

    // Test if we can make a simple fetch request
    try {
      // Don't actually call Shopify yet, just test fetch capability
      diagnosticData.fetch_available = typeof fetch !== 'undefined';
      if (typeof fetch === 'undefined') {
        // Try to require node-fetch
        const fetch = require('node-fetch');
        diagnosticData.node_fetch_available = true;
      }
    } catch (fetchError) {
      diagnosticData.fetch_error = fetchError.message;
    }

    console.log('Diagnostic data:', JSON.stringify(diagnosticData, null, 2));

    // ALWAYS return JSON response
    return res.status(200).json({
      success: true,
      message: 'Diagnostic API is working!',
      data: diagnosticData
    });

  } catch (error) {
    console.error('=== DIAGNOSTIC ERROR ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    // FORCE JSON response even on error
    try {
      return res.status(500).json({
        success: false,
        error: 'Diagnostic API failed',
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
    } catch (jsonError) {
      // If even JSON response fails, try plain text
      res.setHeader('Content-Type', 'application/json');
      res.status(500).send(JSON.stringify({
        success: false,
        error: 'Critical API failure',
        message: error.message,
        json_error: jsonError.message
      }));
    }
  }
}
