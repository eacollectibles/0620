// /api/shopify-image-match.js
// FIXED: Searches for "Pokemon Single" not "Pokemon Singles"

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
      max_results = 5,
      search_type = 'generic',
      card_number = null,
      extracted_text = null
    } = formData.fields;

    console.log('🔍 Search parameters:', {
      search_type,
      card_number,
      threshold: match_threshold,
      max_results,
      has_extracted_text: !!extracted_text,
      extracted_text_preview: extracted_text ? extracted_text.substring(0, 50) : 'none'
    });

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
      console.log('✅ Connected to shop:', shopInfo.name);
      
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

    // Use frontend OCR result if available
    const extractedText = extracted_text || await extractTextFromImage(imageFile);
    console.log('📝 Using extracted text:', extracted_text ? '(from frontend OCR)' : '(from backend)');
    console.log('📝 Full extracted text:', extractedText);

    // ENHANCED SEARCH LOGIC
    if (search_type === 'pokemon_card' && card_number) {
      console.log(`🎯 Direct Pokemon card search requested for: ${card_number}`);
      
      // Search directly for the specified card number
      const searchFormats = [
        card_number,                          // 031182
        card_number.replace(/(\d{3})(\d{3})/, '$1/$2'), // 031/182
        card_number.replace(/(\d{3})(\d{3})/, '$1-$2'),  // 031-182
      ];
      
      for (const searchTerm of searchFormats) {
        console.log(`🔍 Searching for Pokemon card: "${searchTerm}"`);
        
        const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=any&query=${encodeURIComponent(searchTerm)}`;
        
        const searchResponse = await fetch(searchUrl, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          const foundProducts = searchData.products || [];
          console.log(`📦 Found ${foundProducts.length} products for "${searchTerm}"`);
          
          if (foundProducts.length > 0) {
            products = foundProducts;
            console.log(`✅ Using ${foundProducts.length} products from direct card search`);
            console.log('Found products:', foundProducts.map(p => p.title));
            break;
          }
        }
      }
    }
    // POKEMON SINGLES DETECTION - FIXED FOR "Pokemon Single" (no 's')
    else if (extractedText.toLowerCase().includes('pokemon')) {
      console.log('🎯 Pokemon detected! Searching for Pokemon singles...');
      
      // Look for card numbers in the extracted text
      const cardNumberMatch = extractedText.match(/[0O]{0,3}(\d{1,3})[\/\-\s]*(\d{2,3})/);
      
      if (cardNumberMatch) {
        let cardNumber = cardNumberMatch[0]
          .replace(/[O]/g, '0')          // O to 0
          .replace(/[\/\-\s]/g, '');     // Remove separators
        
        console.log(`📋 Card number detected: ${cardNumber}`);
        
        // Try different tag formats for SINGLES
        const tagFormats = [
          cardNumber,                           // 031182
          cardNumber.replace(/^0+/, ''),        // 31182 (no leading zeros)
          cardNumber.replace(/(\d{3})(\d{3})/, '$1/$2'),  // 031/182
          cardNumber.replace(/(\d{3})(\d{3})/, '$1-$2'),  // 031-182
          cardNumber.replace(/(\d{3})(\d{3})/, '$1_$2'),  // 031_182
        ];
        
        console.log('🔍 Trying tag formats:', tagFormats);
        
        let cardNumberProducts = [];
        
        // FIXED: Search for "Pokemon Single" not "Pokemon Singles"
        try {
          console.log('🔍 Searching for "Pokemon Single" product type...');
          
          // Try both singular and plural to be safe
          const productTypes = ['Pokemon Single', 'Pokemon Singles'];
          
          for (const productType of productTypes) {
            const singlesUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=250&published_status=any&product_type=${encodeURIComponent(productType)}`;
            
            console.log(`🔍 Trying product type: "${productType}"`);
            
            const singlesResponse = await fetch(singlesUrl, {
              headers: {
                'X-Shopify-Access-Token': shopifyToken,
                'Content-Type': 'application/json'
              }
            });
            
            if (singlesResponse.ok) {
              const singlesData = await singlesResponse.json();
              const allSingles = singlesData.products || [];
              console.log(`📦 Found ${allSingles.length} products with type "${productType}"`);
              
              if (allSingles.length > 0) {
                // Filter for the specific card number
                const matchingSingles = allSingles.filter(product => {
                  const searchText = [
                    product.title,
                    product.tags,
                    ...(product.variants?.map(v => v.sku) || [])
                  ].join(' ').toLowerCase();
                  
                  return tagFormats.some(format => 
                    searchText.includes(format.toLowerCase())
                  );
                });
                
                if (matchingSingles.length > 0) {
                  cardNumberProducts = matchingSingles;
                  console.log(`✅ Found ${matchingSingles.length} matching singles for card ${cardNumber}`);
                  break; // Found matches, exit loop
                } else {
                  // Use all singles if no specific match but only if we don't have any yet
                  if (cardNumberProducts.length === 0) {
                    cardNumberProducts = allSingles.slice(0, 50);
                    console.log(`⚠️ No exact match, using ${cardNumberProducts.length} Pokemon singles`);
                  }
                }
              }
            }
            
            // If we found products, break out of productTypes loop
            if (cardNumberProducts.length > 0) break;
          }
        } catch (error) {
          console.log(`❌ Singles search error: ${error.message}`);
        }
        
        // Second try: Search with card number using tag search
        if (cardNumberProducts.length === 0) {
          console.log('🔄 Trying tag-based search...');
          
          for (const tagFormat of tagFormats) {
            console.log(`🏷️ Searching by tag: "${tagFormat}"`);
            
            try {
              // Use tag search instead of general query
              const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=any&query=tag:${encodeURIComponent(tagFormat)}`;
              
              const response = await fetch(searchUrl, {
                headers: {
                  'X-Shopify-Access-Token': shopifyToken,
                  'Content-Type': 'application/json'
                }
              });
              
              if (response.ok) {
                const data = await response.json();
                const foundProducts = data.products || [];
                
                console.log(`📦 Found ${foundProducts.length} products with tag "${tagFormat}"`);
                
                // Filter OUT sealed products
                const singlesOnly = foundProducts.filter(p => {
                  const productType = (p.product_type || '').toLowerCase();
                  const title = (p.title || '').toLowerCase();
                  
                  // Exclude sealed products
                  const isSealed = 
                    productType.includes('sealed') || 
                    productType.includes('booster') ||
                    title.includes('booster') || 
                    title.includes('pack') || 
                    title.includes('box');
                  
                  return !isSealed;
                });
                
                console.log(`📦 After filtering: ${singlesOnly.length} are singles`);
                
                if (singlesOnly.length > 0) {
                  cardNumberProducts = singlesOnly;
                  console.log(`✅ Found singles for tag "${tagFormat}"`);
                  break;
                }
              }
            } catch (error) {
              console.log(`❌ Tag search error for "${tagFormat}": ${error.message}`);
            }
          }
        }
        
        // Third try: Search by title if we extracted a Pokemon name
        if (cardNumberProducts.length === 0) {
          console.log('🔄 Trying title-based search...');
          
          // Extract Pokemon name from OCR text
          const lines = extractedText.split('\n').map(l => l.trim());
          const pokemonName = lines.find(line => 
            line.length > 3 && 
            line.length < 20 &&
            !line.match(/^\d+/) && 
            !line.toLowerCase().includes('hp') &&
            !line.toLowerCase().includes('pokemon')
          );
          
          if (pokemonName) {
            console.log(`🔍 Searching by Pokemon name: "${pokemonName}"`);
            
            const titleSearch = await fetch(
              `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=any&query=title:${encodeURIComponent(pokemonName)}`,
              {
                headers: {
                  'X-Shopify-Access-Token': shopifyToken,
                  'Content-Type': 'application/json'
                }
              }
            );
            
            if (titleSearch.ok) {
              const titleData = await titleSearch.json();
              const titleProducts = titleData.products || [];
              console.log(`📦 Found ${titleProducts.length} products by title`);
              
              // Filter for singles only
              const singlesOnly = titleProducts.filter(p => {
                const productType = (p.product_type || '').toLowerCase();
                return productType.includes('single') && !productType.includes('sealed');
              });
              
              if (singlesOnly.length > 0) {
                cardNumberProducts = singlesOnly;
                console.log(`✅ Found ${singlesOnly.length} singles by title`);
              }
            }
          }
        }
        
        if (cardNumberProducts.length > 0) {
          products = cardNumberProducts;
          console.log(`🎯 Final: Using ${cardNumberProducts.length} Pokemon singles for matching`);
        } else {
          console.log('❌ No Pokemon singles found!');
          console.log('💡 Debug info:');
          console.log('   - Extracted text:', extractedText);
          console.log('   - Card number:', cardNumber);
          console.log('   - Tag formats tried:', tagFormats);
        }
      } else {
        console.log('❌ No card number detected in OCR text');
        console.log('Extracted text:', extractedText);
      }
    } else {
      console.log('❌ No Pokemon detected in extracted text');
      console.log('Extracted text:', extractedText);
    }

    // Match products based on extracted text
    const matches = findProductMatches(products, extractedText, {
      threshold: parseFloat(match_threshold),
      maxResults: parseInt(max_results)
    });

    console.log(`✅ Found ${matches.length} final matches`);

    const response = {
      success: true,
      matches: matches,
      total_products_searched: products.length,
      processing_time: Date.now() - startTime,
      shopify_connection: 'direct-rest-api',
      shop_name: shopInfo?.name || 'Unknown',
      store_domain: shopInfo?.domain || shopifyStore + '.myshopify.com',
      extracted_text: extractedText,
      ocr_source: extracted_text ? 'frontend' : 'backend',
      debug_info: {  // Added for mobile debugging
        card_number_detected: extractedText.match(/[0O]{0,3}(\d{1,3})[\/\-\s]*(\d{2,3})/) ? true : false,
        search_type: search_type,
        products_found: products.length,
        matches_returned: matches.length
      },
      image_info: {
        filename: imageFile.filename,
        size: imageFile.data.length,
        type: imageFile.mimetype
      }
    };

    console.log('=== RESPONSE SUMMARY ===');
    console.log('Matches found:', matches.length);
    console.log('Products searched:', products.length);
    console.log('OCR source:', response.ocr_source);
    console.log('Extracted text:', extractedText.substring(0, 100));

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

// Backend OCR fallback
async function extractTextFromImage(imageFile) {
  console.log('=== OCR PROCESSING (Backend Fallback) ===');
  console.log('⚠️ Backend OCR should not be used when frontend OCR is available');
  console.log('Image file size:', imageFile.size);
  console.log('Image type:', imageFile.mimetype);
  
  return '';
}

// Find matching products with SINGLES prioritization
function findProductMatches(products, extractedText, options = {}) {
  const { threshold = 0.3, maxResults = 5 } = options;  // Lowered threshold to 0.3
  
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
    const productType = (product.product_type || '').toLowerCase();
    const title = (product.title || '').toLowerCase();
    
    // BOOST score for singles
    if (productType.includes('single') && !productType.includes('sealed')) {
      score += 0.5;
    }
    
    // PENALTY for sealed products
    if (productType.includes('sealed') || productType.includes('booster') || 
        title.includes('pack') || title.includes('box') || title.includes('booster')) {
      score -= 0.5;
    }
    
    searchTerms.forEach(term => {
      if (productText.includes(' ' + term + ' ') || productText.startsWith(term + ' ') || productText.endsWith(' ' + term)) {
        score += 0.8;
      }
      
      if (productText.includes(term)) {
        score += 0.4;
      }
      
      if (title.includes(term)) {
        score += 0.6;
      }
      
      const productSKUs = product.variants?.map(v => v.sku?.toLowerCase()) || [];
      if (productSKUs.some(sku => sku === term || sku?.includes(term) || term.includes(sku))) {
        score += 1.0;
      }
      
      if (term.match(/\d+[\/\-]?\d+/)) {
        const cardNumberInProduct = [title, ...productSKUs, ...(product.variants?.map(v => v.title?.toLowerCase()) || [])];
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
    console.log(`${i + 1}. "${item.product.title}" | Type: ${item.product.product_type} | Score: ${item.score.toFixed(3)}`);
  });
  
  const qualifyingProducts = scoredProducts.filter(item => item.score >= threshold);
  const finalResults = qualifyingProducts.slice(0, maxResults);
  
  console.log(`Qualifying products (score >= ${threshold}): ${qualifyingProducts.length}`);
  console.log(`Returning top ${finalResults.length} results`);
  
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
