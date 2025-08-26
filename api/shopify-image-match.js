// /api/shopify-image-match.js
// Complete version with Pokemon SINGLES detection (not sealed products)

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
      card_number = null
    } = formData.fields;

    console.log('Search parameters:', {
      search_type,
      card_number,
      threshold: match_threshold,
      max_results
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

    // ENHANCED SEARCH LOGIC - Use frontend parameters if available
    if (search_type === 'pokemon_card' && card_number) {
      console.log(`Direct Pokemon card search requested for: ${card_number}`);
      
      // Search directly for the specified card number
      const searchFormats = [
        card_number,                          // 031182
        card_number.replace(/(\d{3})(\d{3})/, '$1/$2'), // 031/182
        card_number.replace(/(\d{3})(\d{3})/, '$1-$2'),  // 031-182
      ];
      
      for (const searchTerm of searchFormats) {
        console.log(`Searching for Pokemon card: "${searchTerm}"`);
        
        const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=any&query=${encodeURIComponent(searchTerm)}`;
        console.log(`Search URL: ${searchUrl}`);
        
        const searchResponse = await fetch(searchUrl, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          const foundProducts = searchData.products || [];
          console.log(`Found ${foundProducts.length} products for "${searchTerm}"`);
          
          if (foundProducts.length > 0) {
            products = foundProducts;
            console.log(`Using ${foundProducts.length} products from direct card search`);
            console.log('Found products:', foundProducts.map(p => p.title));
            break;
          }
        }
      }
    }
    // POKEMON SINGLES DETECTION (FIXED VERSION)
    else if (extractedText.toLowerCase().includes('pokemon')) {
      console.log('🎯 Pokemon detected! Searching for Pokemon SINGLES...');
      
      // Look for card numbers in the extracted text
      const cardNumberMatch = extractedText.match(/(\d{3}\/\d{3}|\d{2}\/\d{3}|\d{1,3}\/\d{1,3})/);
      
      if (cardNumberMatch) {
        const cardNumber = cardNumberMatch[0];
        console.log(`📋 Card number detected: ${cardNumber}`);
        
        // Try different search strategies specifically for SINGLES
        let cardNumberProducts = [];
        
        // Strategy 1: Search for Pokemon Singles with card number
        const searchQueries = [
          `product_type:"Pokemon Singles" AND ${cardNumber}`,
          `product_type:"Pokemon Singles" AND title:${cardNumber}`,
          `product_type:"Pokemon Singles" AND tag:${cardNumber.replace('/', '')}`,
          `vendor:"Pokemon" AND product_type:"Singles" AND ${cardNumber}`,
          `title:"${cardNumber}" AND NOT product_type:"Sealed"`,
          `${cardNumber} AND product_type:"Singles"`,
          `${cardNumber} -sealed -booster -pack -box`, // Exclude sealed products
        ];
        
        for (const query of searchQueries) {
          console.log(`🔍 Trying query: "${query}"`);
          
          try {
            const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=50&published_status=any&query=${encodeURIComponent(query)}`;
            console.log(`🔗 Search URL: ${searchUrl}`);
            
            const response = await fetch(searchUrl, {
              headers: {
                'X-Shopify-Access-Token': shopifyToken,
                'Content-Type': 'application/json'
              }
            });
            
            if (response.ok) {
              const data = await response.json();
              const foundProducts = data.products || [];
              
              // Filter to ensure we only get singles, not sealed
              const singlesOnly = foundProducts.filter(p => {
                const productType = (p.product_type || '').toLowerCase();
                const title = (p.title || '').toLowerCase();
                const tags = (p.tags || '').toLowerCase();
                
                // Check if it's a single
                const isSingle = 
                  productType.includes('single') || 
                  tags.includes('single') ||
                  (!productType.includes('sealed') && 
                   !productType.includes('booster') && 
                   !title.includes('booster') && 
                   !title.includes('pack') && 
                   !title.includes('box'));
                
                return isSingle;
              });
              
              console.log(`📦 Found ${foundProducts.length} products, ${singlesOnly.length} are singles`);
              
              if (singlesOnly.length > 0) {
                console.log(`✅ Found Pokemon singles:`, singlesOnly.slice(0, 3).map(p => ({
                  title: p.title,
                  type: p.product_type,
                  tags: p.tags
                })));
                
                cardNumberProducts = singlesOnly;
                break;
              }
            }
          } catch (error) {
            console.log(`❌ Query failed: ${error.message}`);
          }
        }
        
        // Strategy 2: Get ALL Pokemon Singles and filter client-side
        if (cardNumberProducts.length === 0) {
          console.log('🔄 Fetching all Pokemon Singles to filter client-side...');
          
          try {
            // First, try to get products with Pokemon Singles product type
            const singlesUrl = `https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=250&published_status=any&product_type=Pokemon Singles`;
            console.log(`🔗 Singles URL: ${singlesUrl}`);
            
            const singlesResponse = await fetch(singlesUrl, {
              headers: {
                'X-Shopify-Access-Token': shopifyToken,
                'Content-Type': 'application/json'
              }
            });
            
            if (singlesResponse.ok) {
              const singlesData = await singlesResponse.json();
              const allSingles = singlesData.products || [];
              console.log(`📦 Found ${allSingles.length} Pokemon Singles total`);
              
              // Now filter for the card number
              const cardNumberVariations = [
                cardNumber,                           // 031/182
                cardNumber.replace('/', ''),          // 031182
                cardNumber.replace('/', '-'),         // 031-182
                cardNumber.replace('/', ' '),         // 031 182
                cardNumber.split('/')[0],            // 031 (just first part)
              ];
              
              const matchingSingles = allSingles.filter(product => {
                const searchText = [
                  product.title,
                  product.tags,
                  ...(product.variants?.map(v => v.sku) || []),
                  ...(product.variants?.map(v => v.title) || [])
                ].join(' ').toLowerCase();
                
                return cardNumberVariations.some(variation => 
                  searchText.includes(variation.toLowerCase())
                );
              });
              
              if (matchingSingles.length > 0) {
                console.log(`✅ Found ${matchingSingles.length} matching singles:`, 
                  matchingSingles.slice(0, 3).map(p => p.title));
                cardNumberProducts = matchingSingles;
              }
            }
          } catch (error) {
            console.log(`❌ Singles fetch failed: ${error.message}`);
          }
        }
        
        // Strategy 3: Search Pokemon products and filter for singles
        if (cardNumberProducts.length === 0) {
          console.log('🔄 Last resort: Get all Pokemon products and filter...');
          
          const pokemonResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=250&published_status=any&query=pokemon`, {
            headers: {
              'X-Shopify-Access-Token': shopifyToken,
              'Content-Type': 'application/json'
            }
          });
          
          if (pokemonResponse.ok) {
            const pokemonData = await pokemonResponse.json();
            const allPokemon = pokemonData.products || [];
            
            // Filter for singles only
            const singles = allPokemon.filter(p => {
              const productType = (p.product_type || '').toLowerCase();
              const title = (p.title || '').toLowerCase();
              
              return (
                productType.includes('single') ||
                (!productType.includes('sealed') && 
                 !title.includes('booster') && 
                 !title.includes('pack') && 
                 !title.includes('box') &&
                 !title.includes('collection'))
              );
            });
            
            console.log(`📦 Found ${allPokemon.length} Pokemon products, ${singles.length} are singles`);
            
            if (singles.length > 0) {
              // Further filter for card number
              const cardNumberVariations = [
                cardNumber,
                cardNumber.replace('/', ''),
                cardNumber.replace('/', '-'),
              ];
              
              const matchingSingles = singles.filter(product => {
                const searchText = (product.title + ' ' + product.tags + ' ' + (product.variants?.[0]?.sku || '')).toLowerCase();
                return cardNumberVariations.some(v => searchText.includes(v.toLowerCase()));
              });
              
              if (matchingSingles.length > 0) {
                cardNumberProducts = matchingSingles;
                console.log(`✅ Found ${matchingSingles.length} matching singles`);
              } else {
                // Use all singles if no specific card match
                cardNumberProducts = singles.slice(0, 50);
                console.log(`⚠️ No exact card match, using first 50 singles`);
              }
            }
          }
        }
        
        if (cardNumberProducts.length > 0) {
          products = cardNumberProducts;
          console.log(`🎯 Using ${cardNumberProducts.length} Pokemon singles for matching`);
        } else {
          console.log('❌ No Pokemon singles found! Check your product categorization in Shopify.');
          console.log('💡 Ensure your Pokemon singles have:');
          console.log('   - product_type: "Pokemon Singles"');
          console.log('   - Tags with card numbers (like "031182" or "031/182")');
          console.log('   - Card numbers in title or SKU');
        }
      } else {
        console.log('❌ No card number detected, trying general Pokemon singles search...');
        
        // Try to get Pokemon singles without specific card number
        const singlesResponse = await fetch(`https://${shopifyStore}.myshopify.com/admin/api/2023-10/products.json?limit=250&published_status=any&product_type=Pokemon Singles`, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          }
        });
        
        if (singlesResponse.ok) {
          const singlesData = await singlesResponse.json();
          const pokemonSingles = singlesData.products || [];
          console.log(`📦 Found ${pokemonSingles.length} Pokemon Singles`);
          
          if (pokemonSingles.length > 0) {
            products = pokemonSingles.slice(0, 50); // Use first 50 singles
            console.log(`🎯 Using ${products.length} Pokemon singles for matching`);
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
  
  // TODO: Replace this with actual OCR processing
  // For now, forcing Pokemon text for testing
  const extractedText = 'Pokemon Card 031/182';
  console.log('🎯 FORCED Pokemon extraction for testing:', extractedText);
  
  return extractedText;
}

// Find matching products with SINGLES prioritization
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
    const productType = (product.product_type || '').toLowerCase();
    
    // BOOST score for singles
    if (productType.includes('single')) {
      score += 0.5;
      console.log(`⬆️ Boosted "${product.title}" for being a single`);
    }
    
    // PENALTY for sealed products
    if (productType.includes('sealed') || productType.includes('booster') || 
        product.title?.toLowerCase().includes('pack') || 
        product.title?.toLowerCase().includes('box')) {
      score -= 0.5;
      console.log(`⬇️ Penalized "${product.title}" for being sealed product`);
    }
    
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
      
      // Card number matching
      if (term.match(/\d+\/\d+/) || term.match(/\d{3,6}/)) {
        const cardNumberInProduct = [productTitle, ...productSKUs, product.tags].filter(Boolean);
        if (cardNumberInProduct.some(field => field?.toLowerCase().includes(term))) {
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
  .filter(item => item.score > 0) // Only include products with positive scores
  .sort((a, b) => b.score - a.score);
  
  console.log('Top 5 scored products:');
  scoredProducts.slice(0, 5).forEach((item, i) => {
    console.log(`${i + 1}. "${item.product.title}" | Type: ${item.product.product_type} | Score: ${item.score.toFixed(3)}`);
  });
  
  const qualifyingProducts = scoredProducts.filter(item => item.score >= threshold);
  const finalResults = qualifyingProducts.slice(0, maxResults);
  
  console.log(`✅ Returning ${finalResults.length} matches above threshold ${threshold}`);
  
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
    match_reason: productType.includes('single') ? 'pokemon_single' : 'text_similarity'
  }));
}
