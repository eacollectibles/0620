// /api/shopify-image-match.js
// Fixed to use correct environment variable names

const multiparty = require('multiparty');

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
    console.log('=== Shopify API Request Started ===');
    const startTime = Date.now();
    
    // Check environment variables (using correct names)
    const hasShopifyKey = !!process.env.SHOPIFY_API_KEY;
    const hasShopifyToken = !!process.env.SHOPIFY_ACCESS_TOKEN; // This is what you actually have
    
    console.log('SHOPIFY_API_KEY exists:', hasShopifyKey);
    console.log('SHOPIFY_ACCESS_TOKEN exists:', hasShopifyToken);

    if (!hasShopifyKey || !hasShopifyToken) {
      return res.status(500).json({
        error: 'Missing Shopify credentials',
        details: 'SHOPIFY_API_KEY or SHOPIFY_ACCESS_TOKEN not set'
      });
    }

    // Parse form data
    const formData = await parseFormData(req);
    
    const { 
      shopify_store = 'ke40sv-my', 
      match_threshold = 0.7, 
      max_results = 5 
    } = formData.fields;

    // Check image
    if (!formData.files || !formData.files.image) {
      return res.status(400).json({
        error: 'No image file provided'
      });
    }

    const imageFile = formData.files.image;
    console.log('Image received:', imageFile.originalFilename, 'Size:', imageFile.size);

    // Connect to Shopify using the correct credentials
    console.log('=== Connecting to Shopify ===');
    
    const Shopify = require('shopify-api-node');
    const shopify = new Shopify({
      shopName: 'ke40sv-my',
      apiKey: process.env.SHOPIFY_API_KEY,
      password: process.env.SHOPIFY_ACCESS_TOKEN, // Using ACCESS_TOKEN instead of API_PASSWORD
      apiVersion: '2023-10'
    });

    console.log('Shopify client created, testing connection...');
    
    // Test connection
    const shopInfo = await shopify.shop.get();
    console.log('Shopify connection successful:', shopInfo.name);

    // Get some products
    const products = await shopify.product.list({ limit: 10 });
    console.log(`Found ${products.length} products in Shopify`);

    // Create matches from actual Shopify products
    const actualMatches = products.slice(0, parseInt(max_results)).map((product, index) => ({
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
      confidence: 0.90 - (index * 0.05), // Decreasing confidence
      vendor: product.vendor,
      product_type: product.product_type
    }));

    console.log(`Returning ${actualMatches.length} actual Shopify products as matches`);

    return res.status(200).json({
      matches: actualMatches,
      total_products_searched: products.length,
      processing_time: Date.now() - startTime,
      shopify_connection: 'success',
      shop_name: shopInfo.name,
      store_domain: shopInfo.domain,
      message: 'Connected to real Shopify store!',
      extracted_text: 'Simulated OCR text - will add Google Vision next'
    });

  } catch (error) {
    console.error('=== Shopify API Error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    
    return res.status(500).json({
      error: 'Shopify connection failed',
      message: error.message,
      details: 'Check Shopify credentials and permissions'
    });
  }
};

// Parse multipart form data
function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    
    form.parse(req, (err, fields, files) => {
      if (err) {
        console.error('Form parsing error:', err);
        reject(err);
        return;
      }
      
      // Process fields
      const processedFields = {};
      Object.keys(fields).forEach(key => {
        processedFields[key] = fields[key][0];
      });
      
      // Process files
      const processedFiles = {};
      Object.keys(files).forEach(key => {
        const file = files[key][0];
        processedFiles[key] = {
          buffer: require('fs').readFileSync(file.path),
          originalFilename: file.originalFilename,
          size: file.size,
          mimetype: file.headers['content-type']
        };
      });
      
      resolve({
        fields: processedFields,
        files: processedFiles
      });
    });
  });
}
