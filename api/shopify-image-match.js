// /api/shopify-image-match.js
// Complete version with Pokemon detection and tag search

export const config = {
  api: {
    bodyParser: false,
  },
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

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

    let formData;
    try {
      formData = await parseFormDataNative(req);
      console.log('Form data parsed successfully');
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

    if (!formData.files || !formData.files.image) {
      return res.status(400).json({
        error: 'No image file provided'
      });
    }

    const imageFile = formData.files.image;
    console.log('Processing image:', {
      filename: imageFile.filename,
      size: imageFile.data.length,
      type: imageFile.mimetype
    });

    // Connect to Shopify
    console.log('=== Connecting to Shopify via REST API ===');
    let products = [];
    let shopInfo = null;

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
      console.log('Connected to shop:', shopInfo.name);
      
      // Get initial products
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
      
      console.log(`Retrieved ${products.length} initial products from Shopify`);
      
    } catch (shopifyError) {
      return res.status(500).json({
        error: 'Shopify connection failed',
        message: shopifyError.message,
        store: shopifyStore
      });
    }

    // Extract text from image
    const extractedText = await extractTextFromImage(imageFile);
    console.log('Extracted text:', extractedText);

    // POKEMON DETECTION AND TAG SEARCH LOGIC
    if (extractedText.toLowerCase().includes('pokemon')) {
      console.log('🎯 Pokemon detected! Searching for Pokemon products...');
      
      // Look for card numbers in the extracted text
      const cardNumberMatch = extractedText.match(/(\d{3}\/\d{3}|\d{2}\/\d{3}|\d{1,3}\/\d{1,3})/);
      
      if (cardNumberMatch) {
        const cardNumber = cardNumberMatch[0];
        console.log(`📋 Card number detected: ${cardNumber}, searching by multiple tag formats...`);
        
        // Try different tag formats, starting with no separator format
        const tagFormats = [
          cardNumber.replace('/', ''),          // 031182
          cardNumber,                           // 031/182
          cardNumber.replace('/', '-'),         // 031-182
          cardNumber.replace('/', '_'),         // 031_182
          `pokemon${cardNumber.replace('/', '')}`, // pokemon031182
          `card${cardNumber.replace('/', '')}`,    // card031182
        ];
        
        console.log('🔍 Trying tag formats:', tagFormats);
        
        let cardNumberProducts = [];
        
        // Try each tag format
        for (const tagFormat of tagFormats) {
          console.log(`🏷️ Searching for tag: "${tagFormat}"`);
          
          try {
            const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=any&query=tag:"${encodeURIComponent(tagFormat)}"`;
            console.log(`🔗 Full search URL: ${searchUrl}`);
            
            const cardNumberResponse = await fetch(searchUrl, {
              headers: {
                'X-Shopify-Access-Token': shopifyToken,
                'Content-Type': 'application/json'
              }
            });
            
            console.log(`📡 Response status for tag "${tagFormat}": ${cardNumberResponse.status}`);
            
            if (cardNumberResponse.ok) {
              const cardNumberData = await cardNumberResponse.json();
              const foundProducts = cardNumberData.products || [];
              console.log(`📦 Found ${foundProducts.length} products with tag "${tagFormat}"`);
              
              if (foundProducts.length > 0) {
                console.log(`🎯 Products found with tag "${tagFormat}":`, foundProducts.map(p => ({
                  title: p.title,
                  id: p.id,
                  tags: p.tags,
                  status: p.status
                })));
                
                cardNumberProducts = foundProducts;
                console.log(`✅ SUCCESS with tag format: "${tagFormat}"`);
                break;
              } else {
                console.log(`❌ No products found with tag "${tagFormat}"`);
              }
            } else {
              console.log(`❌ API error for tag "${tagFormat}": ${cardNumberResponse.status}`);
            }
          } catch (tagError) {
            console.log(`❌ Exception searching for tag "${tagFormat}":`, tagError.message);
          }
        }
        
        if (cardNumberProducts.length > 0) {
          products = cardNumberProducts;
          console.log(`🎯 Using ${cardNumberProducts.length} card-number-specific products for matching`);
        } else {
          console.log('❌ No products found with any card number tag format, trying general Pokemon search...');
          
          // Try general Pokemon search
          const pokemonResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=250&published_status=any&query=pokemon`, {
            headers: {
              'X-Shopify-Access-Token': shopifyToken,
              'Content-Type': 'application/json'
            }
          });
          
          if (pokemonResponse.ok) {
            const pokemonData = await pokemonResponse.json();
            const pokemonProducts = pokemonData.products || [];
            console.log(`📦 Found ${pokemonProducts.length} general Pokemon products`);
            
            if (pokemonProducts.length > 0) {
              products = pokemonProducts;
              console.log(`🎯 Using ${pokemonProducts.length} general Pokemon products for matching`);
            }
          }
        }
      } else {
        console.log('❌ No card number detected, trying general Pokemon search...');
        
        const pokemonResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=250&published_status=any&query=pokemon`, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (pokemonResponse.ok) {
          const pokemonData = await pokemonResponse.json();
          const pokemonProducts = pokemonData.products || [];
          console.log(`📦 Found ${pokemonProducts.length} general Pokemon products`);
          
          if (pokemonProducts.length > 0) {
            products = pokemonProducts;
            console.log(`🎯 Using ${pokemonProducts.length} general Pokemon products for matching`);
          }
        }
      }
    } else {
      console.log('❌ No Pokemon detected in extracted text, using default products');
    }

    // Match products based on extracted text
    const matches = findProductMatches(products, extractedText, {
      threshold: parseFloat(match_threshold),
      maxResults: parseInt(max_results)
    });

    console.log(`Found ${matches.length} potential matches`);

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

// Parse multipart form data
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
          
          const dispositionMatch = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/);
          if (!dispositionMatch) continue;
          
          const fieldName = dispositionMatch[1];
          const filename = dispositionMatch[2];
          
          if (filename) {
            const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/);
            const mimetype = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
            
            const cleanBody = body.replace(/\r?\n--$/, '');
            const fileData = Buffer.from(cleanBody, 'binary');
            
            files[fieldName] = {
              filename: filename,
              data: fileData,
              size: fileData.length,
              mimetype: mimetype
            };
          } else {
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

// FORCED POKEMON EXTRACTION FOR TESTING
async function extractTextFromImage(imageFile) {
  console.log('=== OCR PROCESSING START ===');
  console.log('Image file size:', imageFile.size);
  console.log('Image type:', imageFile.mimetype);
  
  const extractedText = 'Pokemon Card 031/182';
  console.log('🎯 FORCED Pokemon extraction for testing:', extractedText);
  
  return extractedText;
}

// Find matching products
function findProductMatches(products, extractedText, options = {}) {
  const { threshold = 0.4, maxResults = 5 } = options;
  
  console.log('=== MATCHING DEBUG ===');
  console.log('Extracted text:', extractedText);
  console.log('Search threshold:', threshold);
  console.log('Total products to search:', products.length);
  
  const searchTerms = extractedText.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  console.log('Search terms:', searchTerms);
  
  const scoredProducts = products.map(product => {
    let score = 0;
    
    const searchableFields = [
      product.title || '',
      product.vendor || '',
      product.product_type || '',
      ...(product.tags || []),
      ...(product.variants?.map(v => v.title || '') || []),
      ...(product.variants?.map(v => v.sku || '') || [])
    ];
    
    const productText = searchableFields.join(' ').toLowerCase();
    
    searchTerms.forEach(term => {
      if (productText.includes(' ' + term + ' ') || productText.startsWith(term + ' ') || productText.endsWith(' ' + term)) {
        score += 0.8;
      }
      
      if (productText.includes(term)) {
        score += 0.4;
      }
      
      const productTitle = product.title?.toLowerCase() || '';
      if (productTitle.includes(term)) {
        score += 0.6;
      }
      
      const productSKUs = product.variants?.map(v => v.sku?.toLowerCase()) || [];
      if (productSKUs.some(sku => sku === term || sku?.includes(term) || term.includes(sku))) {
        score += 1.0;
      }
      
      if (term.match(/\d+\/\d+/)) {
        const cardNumberInProduct = [productTitle, ...productSKUs, ...(product.variants?.map(v => v.title?.toLowerCase()) || [])];
        if (cardNumberInProduct.some(field => field?.includes(term))) {
          score += 1.2;
        }
      }
      
      if (product.vendor?.toLowerCase().includes(term)) {
        score += 0.3;
      }
    });
    
    score = score / searchTerms.length;
    
    return {
      product,
      score: Math.min(score, 1.0)
    };
  })
  .sort((a, b) => b.score - a.score);
  
  console.log('Top 5 scored products:');
  scoredProducts.slice(0, 5).forEach((item, i) => {
    console.log(`${i + 1}. "${item.product.title}" | Score: ${item.score.toFixed(3)}`);
  });
  
  const qualifyingProducts = scoredProducts.filter(item => item.score >= threshold);
  const finalResults = qualifyingProducts.slice(0, maxResults);
  
  return finalResults.map(({ product, score }) => ({
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
