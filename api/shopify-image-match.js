// /api/shopify-image-match.js
// Step-by-step production version with better error handling

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
    console.log('=== Step 1: API Request Started ===');
    const startTime = Date.now();
    
    // Check environment variables first
    console.log('=== Step 2: Checking Environment Variables ===');
    const hasShopifyKey = !!process.env.SHOPIFY_API_KEY;
    const hasShopifyPassword = !!process.env.SHOPIFY_API_PASSWORD;
    const hasGoogleCreds = !!process.env.GOOGLE_CLOUD_CREDENTIALS;
    
    console.log('SHOPIFY_API_KEY exists:', hasShopifyKey);
    console.log('SHOPIFY_API_PASSWORD exists:', hasShopifyPassword);
    console.log('GOOGLE_CLOUD_CREDENTIALS exists:', hasGoogleCreds);

    if (!hasShopifyKey || !hasShopifyPassword) {
      return res.status(500).json({
        error: 'Missing Shopify credentials',
        details: 'SHOPIFY_API_KEY or SHOPIFY_API_PASSWORD not set'
      });
    }

    // Parse form data
    console.log('=== Step 3: Parsing Form Data ===');
    const formData = await parseFormData(req);
    console.log('Form data parsed successfully');
    
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

    // Try Shopify connection
    console.log('=== Step 4: Testing Shopify Connection ===');
    
    try {
      const Shopify = require('shopify-api-node');
      const shopify = new Shopify({
        shopName: 'ke40sv-my',
        apiKey: process.env.SHOPIFY_API_KEY,
        password: process.env.SHOPIFY_API_PASSWORD,
        apiVersion: '2023-10'
      });

      console.log('Shopify client created, testing connection...');
      
      // Test with a simple request first
      const shopInfo = await shopify.shop.get();
      console.log('Shopify connection successful:', shopInfo.name);

      // Get a few products to test
      const products = await shopify.product.list({ limit: 5 });
      console.log(`Found ${products.length} products in Shopify`);

      // For now, return mock matches based on Shopify connection success
      const mockMatches = products.slice(0, 2).map((product, index) => ({
        title: product.title,
        sku: product.variants?.[0]?.sku || 'NO-SKU',
        variant_sku: product.variants?.[0]?.sku || 'NO-SKU',
        variant_title: product.variants?.[0]?.title || 'Default',
        price: product.variants?.[0]?.price || '0.00',
        compare_at_price: product.variants?.[0]?.compare_at_price || null,
        product_id: product.id,
        variant_id: product.variants?.[0]?.id,
        inventory_quantity: product.variants?.[0]?.inventory_quantity || 0,
        image_url: product.images?.[0]?.src || null,
        confidence: 0.85 - (index * 0.1)
      }));

      return res.status(200).json({
        matches: mockMatches,
        total_products_searched: products.length,
        processing_time: Date.now() - startTime,
        shopify_connection: 'success',
        shop_name: shopInfo.name,
        test_mode: 'shopify_connected'
      });

    } catch (shopifyError) {
      console.error('Shopify connection failed:', shopifyError.message);
      
      return res.status(500).json({
        error: 'Shopify connection failed',
        message: shopifyError.message,
        details: 'Check your Shopify API credentials'
      });
    }

  } catch (error) {
    console.error('=== API Error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      name: error.name,
      step: 'Unknown error occurred'
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
