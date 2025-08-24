// /api/shopify-image-match.js
// Version using Vercel's native form parsing (no multiparty dependency)

export const config = {
  api: {
    bodyParser: false, // Disable default body parser to handle multipart
  },
}

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

    // Parse form data using built-in methods
    let formData;
    try {
      formData = await parseFormDataNative(req);
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
        error: 'No image file provided',
        received: {
          fields: Object.keys(formData.fields),
          files: Object.keys(formData.files)
        }
      });
    }

    const imageFile = formData.files.image;
    console.log('Processing image:', {
      filename: imageFile.filename,
      size: imageFile.data.length,
      type: imageFile.mimetype
    });

    // Connect to Shopify using direct API (no shopify-api-node dependency)
    console.log('=== Connecting to Shopify via REST API ===');
    
    let products = [];
    let shopInfo = null;

    try {
      // Get shop info
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
      console.log('Connected to shop:', shopInfo.name);
      
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
      
      console.log(`Retrieved ${products.length} products from Shopify`);
      
    } catch (shopifyError) {
      return res.status(500).json({
        error: 'Shopify connection failed',
        message: shopifyError.message,
        store: shopifyStore
      });
    }

    // Process image for card matching
    const extractedText = await extractTextFromImage(imageFile);
    console.log('Extracted text (simulated):', extractedText);

    // Match products based on extracted text
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
      shopify_connection: 'direct-rest-api',
      shop_name: shopInfo?.name || 'Unknown',
      store_domain: shopInfo?.domain || shopifyStore + '.myshopify.com',
      extracted_text: extractedText,
      image_info: {
        filename: imageFile.filename,
        size: imageFile.data.length,
        type: imageFile.mimetype
      }
    };

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

// Parse multipart form data using built-in Node.js methods
async function parseFormDataNative(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'];
        
        if (!contentType || !contentType.includes('multipart/form-data')) {
          throw new Error('Content-Type must be multipart/form-data');
        }
        
        // Extract boundary
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        if (!boundaryMatch) {
          throw new Error('No boundary found in Content-Type');
        }
        
        const boundary = '--' + boundaryMatch[1];
        const parts = buffer.toString().split(boundary);
        
        const fields = {};
        const files = {};
        
        for (let part of parts) {
          if (part.trim() === '' || part.trim() === '--') continue;
          
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          
          const headers = part.substring(0, headerEnd);
          const body = part.substring(headerEnd + 4);
          
          // Parse Content-Disposition header
          const dispositionMatch = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/);
          if (!dispositionMatch) continue;
          
          const fieldName = dispositionMatch[1];
          const filename = dispositionMatch[2];
          
          if (filename) {
            // This is a file
            const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/);
            const mimetype = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
            
            // Convert body back to buffer (removing trailing boundary stuff)
            const cleanBody = body.replace(/\r?\n--$/, '');
            const fileData = Buffer.from(cleanBody, 'binary');
            
            files[fieldName] = {
              filename: filename,
              data: fileData,
              size: fileData.length,
              mimetype: mimetype
            };
          } else {
            // This is a regular field
            fields[fieldName] = body.trim().replace(/\r?\n--$/, '');
          }
        }
        
        resolve({ fields, files });
        
      } catch (parseError) {
        reject(new Error(`Form parsing failed: ${parseError.message}`));
      }
    });
    
    req.on('error', (error) => {
      reject(new Error(`Request error: ${error.message}`));
    });
  });
}

// Extract text from image (placeholder)
async function extractTextFromImage(imageFile) {
  const possibleCardTexts = [
    'Pikachu Lightning Pokemon Card',
    'Black Lotus Magic The Gathering',
    'Blue-Eyes White Dragon Yu-Gi-Oh',
    'Charizard Fire Pokemon Card', 
    'Time Walk Magic Vintage',
    'Dark Magician Yu-Gi-Oh Card'
  ];
  
  const filename = imageFile.filename?.toLowerCase() || '';
  
  if (filename.includes('pokemon') || filename.includes('pikachu')) {
    return 'Pikachu Lightning Pokemon Card';
  } else if (filename.includes('magic') || filename.includes('mtg')) {
    return 'Black Lotus Magic The Gathering';
  } else if (filename.includes('yugioh') || filename.includes('dragon')) {
    return 'Blue-Eyes White Dragon Yu-Gi-Oh';
  }
  
  return possibleCardTexts[Math.floor(Math.random() * possibleCardTexts.length)];
}

// Find matching products based on extracted text
function findProductMatches(products, extractedText, options = {}) {
  const { threshold = 0.3, maxResults = 5 } = options; // Lower threshold for more matches
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
    
    // Calculate matching score with more flexible matching
    searchTerms.forEach(term => {
      if (term.length < 2) return; // Skip very short terms
      
      // Exact word match
      if (productText.includes(term)) {
        score += 0.3;
      }
      
      // Partial match (substring)
      const words = productText.split(/\s+/);
      words.forEach(word => {
        if (word.includes(term) || term.includes(word)) {
          score += 0.2;
        }
      });
      
      // Bonus for exact title matches
      if (product.title.toLowerCase().includes(term)) {
        score += 0.4;
      }
      
      // Bonus for SKU matches
      if (product.variants?.some(v => v.sku?.toLowerCase().includes(term))) {
        score += 0.5;
      }
      
      // Brand/vendor matching
      if (product.vendor?.toLowerCase().includes(term)) {
        score += 0.3;
      }
    });
    
    // Normalize score
    score = Math.min(score, 1.0);
    
    return {
      product,
      score: score
    };
  })
  .filter(item => item.score >= threshold)
  .sort((a, b) => b.score - a.score)
  .slice(0, maxResults);
  
  console.log('=== MATCHING DEBUG ===');
  console.log('Search terms:', searchTerms);
  console.log('Threshold:', threshold);
  console.log('Scored products (top 10):');
  products.slice(0, 10).forEach(product => {
    const productText = [product.title, product.vendor, product.product_type].join(' ').toLowerCase();
    console.log(`- "${product.title}" | Vendor: ${product.vendor} | Text: "${productText}"`);
  });
  console.log('Products that passed threshold:', scoredProducts.map(p => ({ title: p.product.title, score: p.score })));
  
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
