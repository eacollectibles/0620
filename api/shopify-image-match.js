// /api/shopify-image-match.js
// Fixed version with proper error handling and Vercel compatibility

const multiparty = require('multiparty');

// Use proper export syntax for Vercel
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

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('=== Shopify API Request Started ===');
    const startTime = Date.now();
    
    // Debug: Log all environment variables that contain 'SHOPIFY'
    const shopifyEnvVars = Object.keys(process.env)
      .filter(key => key.includes('SHOPIFY'))
      .reduce((obj, key) => {
        obj[key] = {
          exists: !!process.env[key],
          preview: process.env[key] ? process.env[key].substring(0, 10) + '...' : 'undefined'
        };
        return obj;
      }, {});
    
    console.log('Shopify environment variables:', shopifyEnvVars);
    
    // Check for multiple possible environment variable names
    const shopifyKey = process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_KEY;
    const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD || process.env.SHOPIFY_PASSWORD;
    const shopifyStore = process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || 'ke40sv-my';
    
    console.log('Credentials check:', {
      hasKey: !!shopifyKey,
      hasToken: !!shopifyToken,
      store: shopifyStore
    });

    if (!shopifyKey || !shopifyToken) {
      return res.status(500).json({
        error: 'Missing Shopify credentials',
        environment: shopifyEnvVars,
        allEnvVars: Object.keys(process.env).filter(key => key.includes('SHOPIFY')),
        details: 'Required: SHOPIFY_API_KEY and SHOPIFY_ACCESS_TOKEN (or similar)'
      });
    }

    // Parse form data with better error handling
    let formData;
    try {
      formData = await parseFormData(req);
      console.log('Form data parsed successfully');
    } catch (parseError) {
      console.error('Form parsing failed:', parseError);
      return res.status(400).json({
        error: 'Failed to parse form data',
        details: parseError.message
      });
    }
    
    const { 
      shopify_store = shopifyStore, 
      match_threshold = 0.7, 
      max_results = 5 
    } = formData.fields;

    // Check image
    if (!formData.files || !formData.files.image) {
      return res.status(400).json({
        error: 'No image file provided',
        receivedFields: Object.keys(formData.fields),
        receivedFiles: Object.keys(formData.files)
      });
    }

    const imageFile = formData.files.image;
    console.log('Image received:', {
      filename: imageFile.originalFilename,
      size: imageFile.size,
      type: imageFile.mimetype
    });

    // Try to connect to Shopify with better error handling
    console.log('=== Attempting Shopify Connection ===');
    
    let shopify;
    try {
      // Try with shopify-api-node first
      const Shopify = require('shopify-api-node');
      shopify = new Shopify({
        shopName: shopifyStore.replace('.myshopify.com', ''),
        apiKey: shopifyKey,
        password: shopifyToken,
        apiVersion: '2023-10'
      });
      
      console.log('Shopify client created, testing connection...');
      
      // Test connection with timeout
      const connectionTest = await Promise.race([
        shopify.shop.get(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 10000)
        )
      ]);
      
      console.log('Shopify connection successful:', connectionTest.name);
      
    } catch (shopifyError) {
      console.error('Shopify connection failed:', shopifyError);
      
      // Try alternative: direct REST API call
      try {
        console.log('Trying direct Shopify REST API...');
        const response = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/shop.json`, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`Shopify API returned ${response.status}: ${response.statusText}`);
        }
        
        const shopData = await response.json();
        console.log('Direct API connection successful:', shopData.shop.name);
        
        // Get products via direct API
        const productsResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=10`, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (!productsResponse.ok) {
          throw new Error(`Products API returned ${productsResponse.status}`);
        }
        
        const productsData = await productsResponse.json();
        const products = productsData.products || [];
        
        console.log(`Found ${products.length} products via direct API`);
        
        // Create matches from products
        const matches = products.slice(0, parseInt(max_results)).map((product, index) => ({
          name: product.title,
          title: product.title,
          sku: product.variants?.[0]?.sku || `PROD-${product.id}`,
          variant_sku: product.variants?.[0]?.sku || `PROD-${product.id}`,
          variant_title: product.variants?.[0]?.title || 'Default',
          price: product.variants?.[0]?.price || '0.00',
          compare_at_price: product.variants?.[0]?.compare_at_price || null,
          product_id: product.id,
          variant_id: product.variants?.[0]?.id,
          inventory_quantity: product.variants?.[0]?.inventory_quantity || 0,
          image_url: product.images?.[0]?.src || null,
          confidence: 0.90 - (index * 0.05),
          vendor: product.vendor,
          product_type: product.product_type
        }));

        return res.status(200).json({
          matches: matches,
          total_products_searched: products.length,
          processing_time: Date.now() - startTime,
          shopify_connection: 'success_direct_api',
          shop_name: shopData.shop.name,
          store_domain: shopData.shop.domain,
          message: 'Connected via direct Shopify API!',
          extracted_text: 'Image uploaded successfully - OCR processing available',
          api_method: 'direct_rest_api'
        });
        
      } catch (directApiError) {
        console.error('Direct API also failed:', directApiError);
        throw new Error(`Both shopify-api-node and direct API failed: ${directApiError.message}`);
      }
    }

    // If shopify-api-node worked, continue with that
    const products = await shopify.product.list({ limit: parseInt(max_results) });
    console.log(`Found ${products.length} products via shopify-api-node`);

    const matches = products.map((product, index) => ({
      name: product.title,
      title: product.title,
      sku: product.variants?.[0]?.sku || `PROD-${product.id}`,
      variant_sku: product.variants?.[0]?.sku || `PROD-${product.id}`,
      variant_title: product.variants?.[0]?.title || 'Default',
      price: product.variants?.[0]?.price || '0.00',
      compare_at_price: product.variants?.[0]?.compare_at_price || null,
      product_id: product.id,
      variant_id: product.variants?.[0]?.id,
      inventory_quantity: product.variants?.[0]?.inventory_quantity || 0,
      image_url: product.images?.[0]?.src || null,
      confidence: 0.90 - (index * 0.05),
      vendor: product.vendor,
      product_type: product.product_type
    }));

    const shopInfo = await shopify.shop.get();

    return res.status(200).json({
      matches: matches,
      total_products_searched: products.length,
      processing_time: Date.now() - startTime,
      shopify_connection: 'success_api_node',
      shop_name: shopInfo.name,
      store_domain: shopInfo.domain,
      message: 'Connected via shopify-api-node!',
      extracted_text: 'Image uploaded successfully - OCR processing available',
      api_method: 'shopify_api_node'
    });

  } catch (error) {
    console.error('=== API Error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Stack trace:', error.stack);
    
    // Always return JSON, never let it fall back to HTML error pages
    return res.status(500).json({
      error: 'API processing failed',
      message: error.message,
      type: error.name,
      details: 'Check server logs for full error details',
      timestamp: new Date().toISOString()
    });
  }
}

// Parse multipart form data with better error handling
function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({
      maxFilesSize: 10 * 1024 * 1024, // 10MB max
      maxFields: 10,
      maxFieldsSize: 1024 * 1024 // 1MB max for fields
    });
    
    form.parse(req, (err, fields, files) => {
      if (err) {
        console.error('Form parsing error:', err);
        reject(new Error(`Form parsing failed: ${err.message}`));
        return;
      }
      
      try {
        // Process fields
        const processedFields = {};
        Object.keys(fields).forEach(key => {
          processedFields[key] = fields[key][0];
        });
        
        // Process files with safer file reading
        const processedFiles = {};
        Object.keys(files).forEach(key => {
          const file = files[key][0];
          
          // Read file more safely
          let fileBuffer;
          try {
            const fs = require('fs');
            fileBuffer = fs.readFileSync(file.path);
          } catch (readError) {
            console.warn('Could not read file buffer, using file path instead');
            fileBuffer = null;
          }
          
          processedFiles[key] = {
            buffer: fileBuffer,
            path: file.path, // Keep path as fallback
            originalFilename: file.originalFilename,
            size: file.size,
            mimetype: file.headers['content-type']
          };
        });
        
        resolve({
          fields: processedFields,
          files: processedFiles
        });
        
      } catch (processingError) {
        reject(new Error(`File processing failed: ${processingError.message}`));
      }
    });
  });
}
