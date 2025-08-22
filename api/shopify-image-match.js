// /api/shopify-image-match.js
// Ultra-simple version without external dependencies

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
    console.log('Headers:', req.headers);
    
    // For now, just return mock data to test if the basic API works
    console.log('Returning mock response...');

    const mockResponse = {
      matches: [
        {
          title: 'Black Lotus - Alpha Edition',
          sku: 'MTG-ALP-001',
          variant_sku: 'MTG-ALP-001-NM',
          variant_title: 'Near Mint',
          price: '15000.00',
          compare_at_price: '20000.00',
          product_id: 'shopify_product_123',
          variant_id: 'shopify_variant_456',
          inventory_quantity: 1,
          image_url: 'https://via.placeholder.com/300x400/0066cc/ffffff?text=Black+Lotus',
          confidence: 0.92
        },
        {
          title: 'Lightning Bolt - Revised',
          sku: 'MTG-REV-045',
          variant_sku: 'MTG-REV-045-LP',
          variant_title: 'Lightly Played',
          price: '25.00',
          compare_at_price: '35.00',
          product_id: 'shopify_product_124',
          variant_id: 'shopify_variant_457',
          inventory_quantity: 8,
          image_url: 'https://via.placeholder.com/300x400/cc6600/ffffff?text=Lightning+Bolt',
          confidence: 0.78
        }
      ],
      total_products_searched: 150,
      processing_time: 850,
      test_mode: true,
      message: 'This is test data - API is working!'
    };

    console.log('Mock response prepared, sending...');
    
    return res.status(200).json(mockResponse);

  } catch (error) {
    console.error('=== API Error ===');
    console.error('Error:', error);
    
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
