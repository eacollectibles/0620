// /api/shopify-image-match.js
// Production version with full Shopify integration

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

  // Only allow POST requests for image processing
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('=== Shopify Image Match API Started ===');
    const startTime = Date.now();
    
    // Check environment variables
    const shopifyKey = process.env.SHOPIFY_API_KEY;
    const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD;
    const shopifyStore = process.env.SHOPIFY_STORE || 'ke40sv-my';
    
    console.log('Environment check:', {
      hasKey: !!shopifyKey,
      hasToken: !!shopifyToken,
      store: shopifyStore
    });

    if (!shopifyKey || !shopifyToken) {
      return res.status(500).json({
        error: 'Missing Shopify credentials',
        details: 'Set SHOPIFY_API_KEY and SHOPIFY_ACCESS_TOKEN environment variables'
      });
    }

    // Parse form data
    let formData;
    try {
      formData = await parseFormData(req);
      console.log('Form data parsed:', {
        fields: Object.keys(formData.fields),
        files: Object.keys(formData.files),
        imageSize: formData.files.image ? formData.files.image.size : 0
      });
    } catch (parseError) {
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

    // Validate image upload
    if (!formData.files || !formData.files.image) {
      return res.status(400).json({
        error: 'No image file provided'
      });
    }

    const imageFile = formData.files.image;
    console.log('Processing image:', {
      filename: imageFile.originalFilename,
      size: imageFile.size,
      type: imageFile.mimetype
    });

    // Connect to Shopify and get products
    console.log('=== Connecting to Shopify ===');
    
    let products = [];
    let shopInfo = null;
    let connectionMethod = 'unknown';

    try {
      // Try shopify-api-node first
      const Shopify = require('shopify-api-node');
      const shopify = new Shopify({
        shopName: shopifyStore.replace('.myshopify.com', ''),
        apiKey: shopifyKey,
        password: shopifyToken,
        apiVersion: '2023-10'
      });
      
      // Test connection and get shop info
      shopInfo = await shopify.shop.get();
      console.log('Shopify connection successful:', shopInfo.name);
      
      // Get products for matching
      products = await shopify.product.list({ 
        limit: 50, // Get more products for better matching
        published_status: 'published'
      });
      
      connectionMethod = 'shopify-api-node';
      console.log(`Retrieved ${products.length} products via shopify-api-node`);
      
    } catch (shopifyError) {
      console.log('shopify-api-node failed, trying direct API:', shopifyError.message);
      
      // Fallback to direct Shopify REST API
      try {
        const shopResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/shop.json`, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (!shopResponse.ok) {
          throw new Error(`Shop API returned ${shopResponse.status}: ${shopResponse.statusText}`);
        }
        
        const shopData = await shopResponse.json();
        shopInfo = shopData.shop;
        
        // Get products
        const productsResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=published`, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (!productsResponse.ok) {
          throw new Error(`Products API returned ${productsResponse.status}`);
        }
        
        const productsData = await productsResponse.json();
        products = productsData.products || [];
        
        connectionMethod = 'direct-rest-api';
        console.log(`Retrieved ${products.length} products via direct API`);
        
      } catch (directError) {
        throw new Error(`All Shopify connection methods failed: ${directError.message}`);
      }
    }

    // Process image for card matching
    // For now, we'll do simple text-based matching
    // TODO: Add actual computer vision/OCR here
    const extractedText = await extractTextFromImage(imageFile);
    console.log('Extracted text (simulated):', extractedText);

    // Match products based on extracted text and product data
    const matches = findProductMatches(products, extractedText, {
      threshold: parseFloat(match_threshold),
      maxResults: parseInt(max_results)
    });

    console.log(`Found ${matches.length} potential matches`);

    // Format response
    const response = {
      success: true,
      matches: matches,
      total_products_searched: products.length,
      processing_time: Date.now() - startTime,
      shopify_connection: connectionMethod,
      shop_name: shopInfo?.name || 'Unknown',
      store_domain: shopInfo?.domain || shopifyStore + '.myshopify.com',
      extracted_text: extractedText,
      image_info: {
        filename: imageFile.originalFilename,
        size: imageFile.size,
        type: imageFile.mimetype
      }
    };

    console.log('Sending response with', matches.length, 'matches');
    return res.status(200).json(response);

  } catch (error) {
    console.error('=== API Error ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: 'Image processing failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Parse multipart form data
function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const multiparty = require('multiparty');
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
        
        // Process files
        const processedFiles = {};
        Object.keys(files).forEach(key => {
          const file = files[key][0];
          
          // Read file buffer safely
          let fileBuffer = null;
          try {
            const fs = require('fs');
            fileBuffer = fs.readFileSync(file.path);
          } catch (readError) {
            console.warn('Could not read file buffer:', readError.message);
          }
          
          processedFiles[key] = {
            buffer: fileBuffer,
            path: file.path,
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

// Extract text from image (placeholder for now)
async function extractTextFromImage(imageFile) {
  // TODO: Implement actual OCR using Google Vision API, Tesseract.js, or similar
  // For now, return simulated extracted text
  
  const possibleCardTexts = [
    'Pikachu Lightning Pokemon Card',
    'Black Lotus Magic The Gathering',
    'Blue-Eyes White Dragon Yu-Gi-Oh',
    'Charizard Fire Pokemon Card',
    'Time Walk Magic Vintage',
    'Dark Magician Yu-Gi-Oh Card'
  ];
  
  // Simulate text extraction based on image filename or random selection
  const filename = imageFile.originalFilename?.toLowerCase() || '';
  
  if (filename.includes('pokemon') || filename.includes('pikachu')) {
    return 'Pikachu Lightning Pokemon Card';
  } else if (filename.includes('magic') || filename.includes('mtg')) {
    return 'Black Lotus Magic The Gathering';
  } else if (filename.includes('yugioh') || filename.includes('dragon')) {
    return 'Blue-Eyes White Dragon Yu-Gi-Oh';
  }
  
  // Default random selection
  return possibleCardTexts[Math.floor(Math.random() * possibleCardTexts.length)];
}

// Find matching products based on extracted text
function findProductMatches(products, extractedText, options = {}) {
  const { threshold = 0.7, maxResults = 5 } = options;
  const searchTerms = extractedText.toLowerCase().split(/\s+/);
  
  const scoredProducts = products.map(product => {
    let score = 0;
    const productText = [
      product.title,
      product.vendor,
      product.product_type,
      ...(product.tags || []),
      ...(product.variants?.map(v => v.title) || []),
      ...(product.variants?.map(v => v.sku) || [])
    ].filter(Boolean).join(' ').toLowerCase();
    
    // Calculate matching score
    searchTerms.forEach(term => {
      if (term.length < 2) return; // Skip very short terms
      
      if (productText.includes(term)) {
        score += term.length / extractedText.length;
      }
      
      // Bonus for exact title matches
      if (product.title.toLowerCase().includes(term)) {
        score += 0.2;
      }
      
      // Bonus for SKU matches
      if (product.variants?.some(v => v.sku?.toLowerCase().includes(term))) {
        score += 0.3;
      }
    });
    
    return {
      product,
      score: Math.min(score, 1.0) // Cap at 100%
    };
  })
  .filter(item => item.score >= threshold)
  .sort((a, b) => b.score - a.score)
  .slice(0, maxResults);
  
  // Format matches for frontend
  return scoredProducts.map(({ product, score }) => ({
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
    confidence: score,
    vendor: product.vendor,
    product_type: product.product_type,
    match_reason: 'text_similarity'
  }));
}
