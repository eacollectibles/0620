// /api/shopify-image-match.js
// Test version with better error logging

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
    console.log('=== API Request Started ===');
    console.log('Method:', req.method);
    console.log('Content-Type:', req.headers['content-type']);
    
    // Check environment variables
    console.log('Environment check:');
    console.log('SHOPIFY_API_KEY:', !!process.env.SHOPIFY_API_KEY);
    console.log('SHOPIFY_API_PASSWORD:', !!process.env.SHOPIFY_API_PASSWORD);
    console.log('GOOGLE_CLOUD_CREDENTIALS:', !!process.env.GOOGLE_CLOUD_CREDENTIALS);

    // Try to parse form data
    console.log('Attempting to parse form data...');
    
    const formData = await parseFormData(req);
    console.log('Form data parsed successfully');
    console.log('Fields:', Object.keys(formData.fields || {}));
    console.log('Files:', Object.keys(formData.files || {}));

    // Check if image exists
    if (!formData.files || !formData.files.image) {
      console.log('No image file found in request');
      return res.status(400).json({
        error: 'No image file provided',
        receivedFields: Object.keys(formData.fields || {}),
        receivedFiles: Object.keys(formData.files || {})
      });
    }

    const imageFile = formData.files.image;
    console.log('Image file info:', {
      filename: imageFile.originalFilename,
      size: imageFile.size,
      mimetype: imageFile.mimetype
    });

    // Return success with mock data for now
    return res.status(200).json({
      matches: [
        {
          title: 'Test Card Match',
          sku: 'TEST-001',
          variant_sku: 'TEST-001-NM',
          variant_title: 'Near Mint',
          price: '10.00',
          compare_at_price: '15.00',
          product_id: 'test_product_123',
          variant_id: 'test_variant_456',
          inventory_quantity: 5,
          image_url: 'https://via.placeholder.com/300x400',
          confidence: 0.85
        }
      ],
      total_products_searched: 100,
      processing_time: 1500,
      test_mode: true
    });

  } catch (error) {
    console.error('=== API Error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      name: error.name,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Parse multipart form data for Vercel
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
        processedFields[key] = fields[key][0]; // Get first value
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
