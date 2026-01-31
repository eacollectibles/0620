module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS request received - sending CORS headers');
    return res.status(200).end();
  }

  console.log('=== API REQUEST START ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Body:', req.body);

  try {
    if (req.method !== 'POST') {
      console.log('❌ Method not allowed:', req.method);
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const estimateMode = req.query?.estimate === 'true';
    const { cards, employeeName, payoutMethod, overrideTotal, customerEmail } = req.body;
    
    console.log('📋 Request data:', {
      cardsCount: cards?.length,
      employeeName,
      payoutMethod,
      overrideTotal,
      customerEmail,
      estimateMode
    });

    // Log card details for debugging SKU matching
    console.log('🃏 Card details:', cards?.map(card => ({
      name: card.cardName,
      sku: card.sku,
      searchMethod: card.searchMethod
    })));

    // Validation
    if (payoutMethod === "store-credit" && !customerEmail && !estimateMode) {
      return res.status(400).json({ error: 'Customer email is required for store credit payouts' });
    }

    // Validate override total
    let validatedOverride = null;
    if (overrideTotal !== undefined && overrideTotal !== null && overrideTotal !== '') {
      const override = parseFloat(overrideTotal);
      if (isNaN(override) || override < 0) {
        return res.status(400).json({ error: 'Override total must be a valid positive number' });
      }
      if (override > 13500) {
        return res.status(400).json({ error: 'Override total exceeds maximum allowed limit ($13,500 CAD)' });
      }
      validatedOverride = override;
    }

    if (!cards || !Array.isArray(cards)) {
      return res.status(400).json({ error: 'Invalid or missing cards array' });
    }

    // Complete Shopify configuration from Vercel environment variables
    const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
    const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
    const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
    const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    // Validate required environment variables
    if (!SHOPIFY_DOMAIN || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_ACCESS_TOKEN) {
      console.error('❌ Missing required environment variables');
      console.error('Required credentials status:', {
        SHOPIFY_DOMAIN: !!SHOPIFY_DOMAIN,
        SHOPIFY_API_KEY: !!SHOPIFY_API_KEY,
        SHOPIFY_API_SECRET: !!SHOPIFY_API_SECRET,
        SHOPIFY_ACCESS_TOKEN: !!SHOPIFY_ACCESS_TOKEN
      });
      return res.status(500).json({ 
        error: 'Server configuration error',
        details: 'Missing Shopify credentials'
      });
    }

    console.log('🛍️ Shopify config:', {
      domain: SHOPIFY_DOMAIN,
      hasApiKey: !!SHOPIFY_API_KEY,
      hasApiSecret: !!SHOPIFY_API_SECRET,
      hasAccessToken: !!SHOPIFY_ACCESS_TOKEN
    });

    // Helper function for authenticated Shopify API requests
    const makeShopifyRequest = async (endpoint, options = {}) => {
      const defaultHeaders = {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': `Trade-in-System/1.0 (API Key: ${SHOPIFY_API_KEY.substring(0, 8)}...)`
      };

      return fetch(`https://${SHOPIFY_DOMAIN}${endpoint}`, {
        ...options,
        headers: {
          ...defaultHeaders,
          ...options.headers
        }
      });
    };

    // Helper function for GraphQL requests
    const makeShopifyGraphQLRequest = async (query, variables = {}) => {
      return makeShopifyRequest('/admin/api/2023-10/graphql.json', {
        method: 'POST',
        body: JSON.stringify({ 
          query,
          variables
        })
      });
    };

    // Trade rate calculation functions
    function calculateMaximumTradeValue(marketValue) {
      const price = parseFloat(marketValue);
      
      if (price >= 50.00) return parseFloat((price * 0.75).toFixed(2));
      if (price >= 25.00) return parseFloat((price * 0.70).toFixed(2));
      if (price >= 15.01) return parseFloat((price * 0.65).toFixed(2));
      if (price >= 8.00) return parseFloat((price * 0.50).toFixed(2));
      if (price >= 5.00) return parseFloat((price * 0.35).toFixed(2));
      if (price >= 3.01) return parseFloat((price * 0.25).toFixed(2));
      if (price >= 2.00) return 0.50;
      if (price >= 0.01) return 0.01;
      return 0;
    }

    function calculateSuggestedTradeValue(marketValue) {
      const price = parseFloat(marketValue);
      
      if (price >= 50.00) return parseFloat((price * 0.75).toFixed(2));
      if (price >= 25.00) return parseFloat((price * 0.50).toFixed(2));
      if (price >= 15.01) return parseFloat((price * 0.35).toFixed(2));
      if (price >= 8.00) return parseFloat((price * 0.40).toFixed(2));
      if (price >= 5.00) return parseFloat((price * 0.35).toFixed(2));
      if (price >= 3.01) return parseFloat((price * 0.25).toFixed(2));
      if (price >= 2.00) return 0.10;
      if (price >= 0.01) return 0.01;
      return 0;
    }

    // Helper function to normalize card names/tags for search
    function normalizeSearchTerm(term) {
      if (!term) return '';
      
      // Convert "138/131" format to "138131" for tag searches
      const normalized = term.replace(/[\/\-\s]/g, '');
      console.log(`🔄 Normalized "${term}" to "${normalized}"`);
      return normalized;
    }

    // ========== ENHANCED ONE PIECE / POKEMON CARD NUMBER HANDLING ==========
    // Normalize One Piece / Pokemon set+number patterns
    // "EB03-026" -> "EB03026", "OP09 001" -> "OP09001"
    function normalizeCardNumber(cardName) {
      if (!cardName) return cardName;
      
      // One Piece patterns: OP09-001, EB03-026, ST01-001, PRB-001
      const onePiecePattern = /^(OP|EB|ST|PRB)\s*(\d{1,2})[\s\-]*(\d{1,3})$/i;
      const match = cardName.match(onePiecePattern);
      
      if (match) {
        const prefix = match[1].toUpperCase();
        const setNum = match[2].padStart(2, '0');
        const cardNum = match[3].padStart(3, '0');
        const normalized = `${prefix}${setNum}${cardNum}`;
        console.log(`🎴 Normalized One Piece "${cardName}" to "${normalized}"`);
        return normalized;
      }
      
      // Pokemon patterns: SV07-025, SV07 025, SV7-25
      const pokemonPattern = /^(SV|SM|XY|BW|SWSH)\s*(\d{1,2})[\s\-]*(\d{1,3})$/i;
      const pkMatch = cardName.match(pokemonPattern);
      
      if (pkMatch) {
        const prefix = pkMatch[1].toUpperCase();
        const setNum = pkMatch[2].padStart(2, '0');
        const cardNum = pkMatch[3].padStart(3, '0');
        const normalized = `${prefix}${setNum}${cardNum}`;
        console.log(`⚡ Normalized Pokemon "${cardName}" to "${normalized}"`);
        return normalized;
      }
      
      return cardName;
    }

    // Helper function to extract potential tags from card names
    function extractPotentialTags(cardName) {
      if (!cardName) return [];
      
      const tags = [];
      
      // ========== ONE PIECE / POKEMON SET PATTERNS ==========
      // First, check if it's a One Piece or Pokemon set pattern and normalize it
      const normalizedCardNum = normalizeCardNumber(cardName);
      if (normalizedCardNum !== cardName) {
        tags.push(normalizedCardNum);
        console.log(`🏷️ Added normalized card number: ${normalizedCardNum}`);
      }
      
      // One Piece patterns in longer strings: "Luffy OP09-001" or "EB03-026 Super Rare"
      const onePieceInString = cardName.match(/(OP|EB|ST|PRB)\s*(\d{1,2})[\s\-]*(\d{1,3})/gi);
      if (onePieceInString) {
        onePieceInString.forEach(match => {
          const normalized = normalizeCardNumber(match.trim());
          if (normalized && !tags.includes(normalized)) {
            tags.push(normalized);
            console.log(`🏷️ Extracted One Piece tag from string: ${normalized}`);
          }
        });
      }
      
      // Pokemon patterns in longer strings: "Charizard SV07-025"
      const pokemonInString = cardName.match(/(SV|SM|XY|BW|SWSH)\s*(\d{1,2})[\s\-]*(\d{1,3})/gi);
      if (pokemonInString) {
        pokemonInString.forEach(match => {
          const normalized = normalizeCardNumber(match.trim());
          if (normalized && !tags.includes(normalized)) {
            tags.push(normalized);
            console.log(`🏷️ Extracted Pokemon tag from string: ${normalized}`);
          }
        });
      }
      
      // ========== ORIGINAL NUMBER PATTERNS ==========
      // Look for number/number patterns (like 138/131)
      const numberPattern = /(\d+)[\/\-](\d+)/g;
      let match;
      while ((match = numberPattern.exec(cardName)) !== null) {
        // Add both original and normalized versions
        tags.push(match[0]); // Original: "138/131"
        tags.push(match[1] + match[2]); // Normalized: "138131"
      }
      
      // Look for standalone numbers that might be set numbers
      const standaloneNumbers = cardName.match(/\b\d{3,6}\b/g);
      if (standaloneNumbers) {
        tags.push(...standaloneNumbers);
      }
      
      // Also try the full card name as a tag (normalized)
      tags.push(normalizeSearchTerm(cardName));
      
      const uniqueTags = [...new Set(tags)];
      console.log(`🏷️ Extracted ${uniqueTags.length} potential tags from "${cardName}":`, uniqueTags);
      return uniqueTags;
    }

    // Normalize text for comparison
    function normalizeForComparison(text) {
      if (!text) return '';
      
      return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
        .replace(/\s+/g, ' ')      // Collapse multiple spaces
        .trim();
    }

    // Simple similarity calculation (Jaccard similarity on word sets)
    function calculateSimilarity(str1, str2) {
      const words1 = new Set(str1.split(' ').filter(w => w.length > 1));
      const words2 = new Set(str2.split(' ').filter(w => w.length > 1));
      
      const intersection = new Set([...words1].filter(x => words2.has(x)));
      const union = new Set([...words1, ...words2]);
      
      if (union.size === 0) return 0;
      
      return intersection.size / union.size;
    }

    // Enhanced variant matching that considers both product and variant titles
    function findBestVariantMatch(searchName, options) {
      let bestScore = 0;
      let bestOption = options[0]; // Default to first option

      const normalizedSearch = normalizeForComparison(searchName);

      options.forEach(option => {
        // Compare against full title (product + variant)
        const normalizedFull = normalizeForComparison(option.fullTitle);
        const fullScore = calculateSimilarity(normalizedSearch, normalizedFull);
        
        // Also compare against just product title
        const normalizedProduct = normalizeForComparison(option.productTitle);
        const productScore = calculateSimilarity(normalizedSearch, normalizedProduct);
        
        // Use the better score
        const score = Math.max(fullScore, productScore * 0.9); // Slight preference for full title matches
        
        console.log(`🔍 Scoring "${option.fullTitle}": ${score.toFixed(3)} (full: ${fullScore.toFixed(3)}, product: ${productScore.toFixed(3)})`);
        
        if (score > bestScore) {
          bestScore = score;
          bestOption = option;
        }
      });

      return { option: bestOption, score: bestScore };
    }

    // Get location ID for inventory updates
    let locationId = null;
    if (!estimateMode) {
      try {
        const locationRes = await makeShopifyRequest('/admin/api/2023-10/locations.json');
        const locations = await locationRes.json();
        locationId = locations.locations?.[0]?.id;
        console.log('📍 Location ID:', locationId);
      } catch (err) {
        console.error('❌ Failed to get location ID:', err);
      }
    }

    // Get variant by exact SKU - for frontend confirmed searches
    const getVariantBySku = async (sku) => {
      console.log('🎯 Getting exact variant by SKU:', sku);
      
      const query = `{
        productVariants(first: 1, query: "sku:${sku}") {
          edges {
            node {
              id
              title
              sku
              price
              inventoryQuantity
              image {
                url
              }
              inventoryItem {
                id
              }
              product {
                id
                title
                tags
                featuredImage {
                  url
                }
              }
            }
          }
        }
      }`;

      const graphqlRes = await makeShopifyGraphQLRequest(query);
      const json = await graphqlRes.json();
      console.log('🎯 Exact SKU GraphQL response:', JSON.stringify(json, null, 2));
      
      const variantEdge = json?.data?.productVariants?.edges?.[0];
      
      if (variantEdge?.node) {
        const variant = variantEdge.node;
        const inventoryItemId = variant.inventoryItem?.id;
        
        // Extract numeric ID from GraphQL ID
        const numericInventoryItemId = inventoryItemId ? inventoryItemId.replace('gid://shopify/InventoryItem/', '') : null;
        
        console.log('🎯 Found exact variant:', {
          sku: variant.sku,
          price: variant.price,
          inventoryItemId: inventoryItemId,
          numericInventoryItemId: numericInventoryItemId
        });
        
        // Extract product ID from GraphQL ID
        const productId = variant.product.id;
        
        return {
          found: true,
          product: { title: variant.product.title, id: productId },
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: numericInventoryItemId,
            product_id: productId
          },
          searchMethod: 'exact_sku',
          image: variant.image?.url || variant.product.featuredImage?.url || null,
          tags: Array.isArray(variant.product.tags) ? variant.product.tags : []
        };
      }
      
      console.log('🎯 Exact SKU not found');
      return { found: false };
    };

    // Search by title with better normalization
    const searchByTitle = async (query) => {
      console.log('🔍 Searching by title:', query);
      
      const productRes = await makeShopifyRequest(
        `/admin/api/2023-10/products.json?title=${encodeURIComponent(query)}`
      );

      const productData = await productRes.json();
      console.log('🔍 Title search response:', JSON.stringify(productData, null, 2));
      
      if (productData?.products?.length > 0) {
        const product = productData.products[0];
        const variant = product.variants[0];
        
        console.log('🔍 Title search found variant:', {
          sku: variant.sku,
          price: variant.price,
          inventory_item_id: variant.inventory_item_id
        });
        
        return {
          found: true,
          product: product,
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: variant.inventory_item_id,
            product_id: product.id
          },
          searchMethod: 'title',
          image: product.image?.src || product.images?.[0]?.src || null
        };
      }
      
      return { found: false };
    };

    const searchBySKU = async (sku) => {
      console.log('🔍 Searching by SKU (fallback):', sku);
      
      const query = `{
        productVariants(first: 1, query: "sku:${sku}") {
          edges {
            node {
              id
              title
              sku
              price
              inventoryQuantity
              image {
                url
              }
              inventoryItem {
                id
              }
              product {
                id
                title
                tags
                featuredImage {
                  url
                }
              }
            }
          }
        }
      }`;

      const graphqlRes = await makeShopifyGraphQLRequest(query);
      const json = await graphqlRes.json();
      console.log('🔍 SKU GraphQL response:', JSON.stringify(json, null, 2));
      
      const variantEdge = json?.data?.productVariants?.edges?.[0];
      
      if (variantEdge?.node) {
        const variant = variantEdge.node;
        const inventoryItemId = variant.inventoryItem?.id;
        
        // Extract numeric ID from GraphQL ID
        const numericInventoryItemId = inventoryItemId ? inventoryItemId.replace('gid://shopify/InventoryItem/', '') : null;
        
        console.log('🔍 SKU search found variant:', {
          sku: variant.sku,
          price: variant.price,
          inventoryItemId: inventoryItemId,
          numericInventoryItemId: numericInventoryItemId
        });
        
        // Get product ID from variant's product
        const productId = variant.product.id;
        
        return {
          found: true,
          product: { title: variant.product.title, id: productId },
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: numericInventoryItemId,
            product_id: productId
          },
          searchMethod: 'sku',
          image: variant.image?.url || variant.product.featuredImage?.url || null,
          tags: Array.isArray(variant.product.tags) ? variant.product.tags : []
        };
      }
      
      return { found: false };
    };

    // FIXED: Enhanced tag search that returns ALL matches, not just the first one
    const searchByTagWithAllOptions = async (tag, originalCardName) => {
      console.log('🏷️ Searching by tag for ALL options:', tag, 'for card:', originalCardName);
      
      const normalizedTag = normalizeSearchTerm(tag);
      
      const query = `{
        products(first: 20, query: "tag:${normalizedTag}") {
          edges {
            node {
              id
              title
              tags
              featuredImage {
                url
              }
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity
                    inventoryItem {
                      id
                    }
                    product {
                      id
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }`;

      const graphqlRes = await makeShopifyGraphQLRequest(query);
      const json = await graphqlRes.json();
      console.log(`🏷️ Tag search for "${normalizedTag}" found ${json?.data?.products?.edges?.length || 0} products`);
      
      const products = json?.data?.products?.edges || [];
      
      if (products.length === 0) {
        return { found: false };
      }

      // Flatten all variants from all products
      const allOptions = [];
      products.forEach(productEdge => {
        const product = productEdge.node;
        product.variants.edges.forEach(variantEdge => {
          const variant = variantEdge.node;
          allOptions.push({
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            price: parseFloat(variant.price || 0),
            inventory: variant.inventoryQuantity,
            inventoryItemId: variant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', ''),
            fullTitle: variant.title !== 'Default Title' ? `${product.title} - ${variant.title}` : product.title,
            productId: product.id,
            variantId: variant.id,
            image: product.featuredImage?.url || null,
            tags: Array.isArray(product.tags) ? product.tags : []
          });
        });
      });

      console.log(`🔍 Found ${allOptions.length} total variants across ${products.length} products`);

      if (allOptions.length === 1) {
        // Only one option, return it directly
        const option = allOptions[0];
        return {
          found: true,
          product: { title: option.productTitle, id: option.productId },
          variant: {
            sku: option.sku,
            price: option.price,
            inventory_item_id: option.inventoryItemId,
            product_id: option.productId
          },
          searchMethod: 'tag_single',
          confidence: 'high',
          image: option.image || null
        };
      }

      // Multiple options - find best match or return for user selection
      const bestMatch = findBestVariantMatch(originalCardName, allOptions);
      
      if (bestMatch.score > 0.8) {
        // High confidence match
        console.log(`🎯 High confidence match: "${bestMatch.option.fullTitle}" (score: ${bestMatch.score.toFixed(2)})`);
        
        return {
          found: true,
          product: { title: bestMatch.option.productTitle, id: bestMatch.option.productId },
          variant: {
            sku: bestMatch.option.sku,
            price: bestMatch.option.price,
            inventory_item_id: bestMatch.option.inventoryItemId,
            product_id: bestMatch.option.productId
          },
          searchMethod: 'tag_confident',
          confidence: 'high',
          alternativeCount: allOptions.length - 1,
          allOptions: allOptions, // Include all options for frontend
          image: bestMatch.option.image || null
        };
      }

      // Medium/low confidence - return best guess but flag for user confirmation
      console.log(`⚠️ Multiple options found, best guess: "${bestMatch.option.fullTitle}" (score: ${bestMatch.score.toFixed(2)})`);
      
      return {
        found: true,
        product: { title: bestMatch.option.productTitle, id: bestMatch.option.productId },
        variant: {
          sku: bestMatch.option.sku,
          price: bestMatch.option.price,
          inventory_item_id: bestMatch.option.inventoryItemId,
          product_id: bestMatch.option.productId
        },
        searchMethod: 'tag_uncertain',
        confidence: bestMatch.score > 0.5 ? 'medium' : 'low',
        alternativeCount: allOptions.length - 1,
        allOptions: allOptions, // Include all options for frontend selection
        needsConfirmation: true,
        image: bestMatch.option.image || null
      };
    };

    // FIXED: Updated main search function with enhanced tag search
    const searchCard = async (card) => {
      const { cardName, sku, searchMethod } = card;
      
      console.log(`🔍 Processing card: ${cardName}`);
      console.log(`  - SKU provided: ${sku}`);
      console.log(`  - Search method: ${searchMethod}`);
      
      // PRIORITY 1: If frontend confirmed exact SKU, use it
      if (sku && searchMethod === 'exact_sku') {
        console.log('🎯 Using exact SKU from frontend confirmation');
        const exactResult = await getVariantBySku(sku);
        if (exactResult.found) {
          console.log('✅ Exact SKU match found');
          return exactResult;
        } else {
          console.warn('⚠️ Exact SKU not found, falling back to other methods');
        }
      }
      
      // PRIORITY 2: Try enhanced tag search with multiple options
      const potentialTags = extractPotentialTags(cardName);
      
      for (const tag of potentialTags) {
        if (!tag || tag.length < 2) continue;
        
        try {
          const result = await searchByTagWithAllOptions(tag, cardName);
          if (result.found) {
            console.log(`✅ Found via tag "${tag}": ${result.product.title}`);
            return result;
          }
        } catch (error) {
          console.log(`❌ Tag search failed for "${tag}":`, error.message);
          continue;
        }
      }
      
      // FALLBACK: Use other search methods
      const searchMethods = [
        { query: cardName, method: searchByTitle, name: 'title' },
        { query: sku || cardName, method: searchBySKU, name: 'sku' }
      ].filter(s => s.query); // Remove null/empty queries

      for (const { query, method, name } of searchMethods) {
        try {
          const result = await method(query);
          if (result.found) {
            console.log(`✅ Found via ${name}: ${result.product.title}`);
            return result;
          }
        } catch (error) {
          console.log(`❌ ${name} search failed for ${query}:`, error.message);
          continue;
        }
      }
      
      console.log(`❌ No matches found for: ${cardName}`);
      return { found: false };
    };

    // FIXED: Enhanced inventory update function that uses exact inventory_item_id
    async function updateInventoryForVariant(variant, quantity, cardName, locationId) {
      // Ensure we have all required data
      if (!variant.inventory_item_id) {
        console.error(`❌ No inventory_item_id for ${cardName}, cannot update inventory`);
        return false;
      }

      if (!locationId) {
        console.error(`❌ No location ID available, cannot update inventory`);
        return false;
      }

      try {
        console.log(`📦 Updating inventory for ${cardName}:`);
        console.log(`  - SKU: ${variant.sku}`);
        console.log(`  - Location ID: ${locationId}`);
        console.log(`  - Inventory Item ID: ${variant.inventory_item_id}`);
        console.log(`  - Quantity adjustment: +${quantity}`);
        
        const adjustRes = await makeShopifyRequest('/admin/api/2023-10/inventory_levels/adjust.json', {
          method: 'POST',
          body: JSON.stringify({
            location_id: parseInt(locationId),
            inventory_item_id: parseInt(variant.inventory_item_id),
            available_adjustment: parseInt(quantity)
          })
        });
        
        console.log(`📦 Inventory adjustment response status: ${adjustRes.status}`);
        
        if (adjustRes.ok) {
          const adjustData = await adjustRes.json();
          console.log(`✅ Inventory updated for ${cardName}: +${quantity}`);
          console.log(`📦 New inventory level:`, adjustData.inventory_level);
          return true;
        } else {
          const errorText = await adjustRes.text();
          console.error(`❌ Failed to update inventory for ${cardName}:`, errorText);
          console.error(`📦 Request details:`, {
            location_id: parseInt(locationId),
            inventory_item_id: parseInt(variant.inventory_item_id),
            available_adjustment: parseInt(quantity)
          });
          return false;
        }
      } catch (inventoryErr) {
        console.error(`❌ Failed to update inventory for ${cardName}:`, inventoryErr);
        return false;
      }
    }

    // Add "justtraded" tag to a product
    async function addJustTradedTag(productId, cardName) {
      if (!productId) {
        console.error(`❌ No product_id for ${cardName}, cannot add tag`);
        return false;
      }

      try {
        // Extract numeric ID if it's a GraphQL ID
        const numericProductId = productId.toString().includes('gid://') 
          ? productId.replace('gid://shopify/Product/', '') 
          : productId;

        console.log(`🏷️ Adding 'justtraded' tag to ${cardName} (Product ID: ${numericProductId})`);

        // First get current tags
        const getRes = await makeShopifyRequest(`/admin/api/2023-10/products/${numericProductId}.json`);
        
        if (!getRes.ok) {
          console.error(`❌ Failed to get product for tagging:`, await getRes.text());
          return false;
        }

        const productData = await getRes.json();
        const currentTags = productData.product.tags || '';
        
        // Check if already has the tag
        const tagArray = currentTags.split(',').map(t => t.trim()).filter(t => t);
        if (tagArray.includes('justtraded')) {
          console.log(`🏷️ Product already has 'justtraded' tag`);
          return true;
        }

        // Add the new tag
        tagArray.push('justtraded');
        const newTags = tagArray.join(', ');

        // Update product with new tags
        const updateRes = await makeShopifyRequest(`/admin/api/2023-10/products/${numericProductId}.json`, {
          method: 'PUT',
          body: JSON.stringify({
            product: {
              id: numericProductId,
              tags: newTags
            }
          })
        });

        if (updateRes.ok) {
          console.log(`✅ Added 'justtraded' tag to ${cardName}`);
          return true;
        } else {
          console.error(`❌ Failed to add tag:`, await updateRes.text());
          return false;
        }
      } catch (tagErr) {
        console.error(`❌ Failed to add 'justtraded' tag for ${cardName}:`, tagErr);
        return false;
      }
    }

    // FIXED: Updated main processing loop to handle exact inventory updates
    async function processTradeCards(cards, estimateMode, locationId) {
      let totalSuggestedValue = 0;
      let totalMaximumValue = 0;
      let totalRetailValue = 0;
      const results = [];
      const inventoryUpdates = []; // Track inventory updates for verification

      console.log('⏱️ Processing', cards.length, 'cards');

      for (const card of cards) {
        const { cardName, sku = null, quantity = 1, condition = 'NM', searchMethod = null } = card;
        
        console.log(`🃏 Processing: ${cardName}`);
        console.log(`  - SKU: ${sku}`);
        console.log(`  - Quantity: ${quantity}`);
        console.log(`  - Search Method: ${searchMethod}`);
        
        const searchResult = await searchCard(card);
        
        if (!searchResult.found) {
          console.log('❌ No match found for:', cardName);
          results.push({
            cardName,
            match: null,
            retailPrice: 0,
            suggestedTradeValue: 0,
            maximumTradeValue: 0,
            quantity,
            condition,
            sku: null,
            searchMethod: 'none',
            inventoryUpdated: false
          });
          continue;
        }

        const product = searchResult.product;
        const variant = searchResult.variant;
        const variantPrice = parseFloat(variant.price || 0);
        const suggestedTradeValue = calculateSuggestedTradeValue(variantPrice);
        const maximumTradeValue = calculateMaximumTradeValue(variantPrice);
        
        totalSuggestedValue += suggestedTradeValue * quantity;
        totalMaximumValue += maximumTradeValue * quantity;
        totalRetailValue += variantPrice * quantity;

        console.log(`✅ Found: ${product.title} - $${variantPrice} (Suggested: $${suggestedTradeValue})`);
        console.log(`  - Final SKU: ${variant.sku}`);
        console.log(`  - Search Method: ${searchResult.searchMethod}`);
        console.log(`  - Inventory Item ID: ${variant.inventory_item_id}`);

        // Update inventory if not in estimate mode and we have the required data
        let inventoryUpdated = false;
        let tagAdded = false;
        if (!estimateMode && locationId && variant.inventory_item_id) {
          inventoryUpdated = await updateInventoryForVariant(variant, quantity, cardName, locationId);
          
          if (inventoryUpdated) {
            inventoryUpdates.push({
              cardName,
              sku: variant.sku,
              inventoryItemId: variant.inventory_item_id,
              quantityAdded: quantity
            });
            
            // Add "justtraded" tag to the product
            tagAdded = await addJustTradedTag(variant.product_id, cardName);
          }
        } else {
          console.log(`📦 Skipping inventory update for ${cardName}:`);
          console.log(`  - Estimate mode: ${estimateMode}`);
          console.log(`  - Location ID: ${locationId}`);
          console.log(`  - Inventory Item ID: ${variant.inventory_item_id}`);
        }

        results.push({
          cardName,
          match: product.title,
          retailPrice: variantPrice,
          suggestedTradeValue,
          maximumTradeValue,
          quantity,
          condition,
          sku: variant.sku,
          searchMethod: searchResult.searchMethod,
          inventoryUpdated,
          inventoryItemId: variant.inventory_item_id,
          // Include additional data for debugging and frontend
          confidence: searchResult.confidence,
          alternativeCount: searchResult.alternativeCount,
          allOptions: searchResult.allOptions,
          image: searchResult.image || null,
          tags: searchResult.tags || []
        });
      }

      // Log inventory update summary
      if (inventoryUpdates.length > 0) {
        console.log('📦 Inventory Update Summary:');
        inventoryUpdates.forEach(update => {
          console.log(`  ✅ ${update.cardName} (SKU: ${update.sku}): +${update.quantityAdded}`);
        });
      }

      return {
        results,
        totals: {
          totalSuggestedValue,
          totalMaximumValue,
          totalRetailValue
        },
        inventoryUpdates
      };
    }

    // Customer and store credit functions with updated API calls
    const findOrCreateCustomer = async (email) => {
      try {
        // Search for existing customer
        const searchRes = await makeShopifyRequest(
          `/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`
        );
        
        const searchData = await searchRes.json();
        
        if (searchData.customers?.length > 0) {
          console.log('✅ Existing customer found');
          return searchData.customers[0];
        }

        // Create new customer
        const createRes = await makeShopifyRequest('/admin/api/2023-10/customers.json', {
          method: 'POST',
          body: JSON.stringify({
            customer: {
              email: email,
              first_name: "Trade-in",
              last_name: "Customer",
              note: "Customer created via trade-in system",
              tags: "trade-in-customer"
            }
          })
        });

        if (!createRes.ok) {
          throw new Error(`Failed to create customer: ${await createRes.text()}`);
        }

        const customerData = await createRes.json();
        console.log('✅ New customer created:', customerData.customer.id);
        return customerData.customer;
      } catch (err) {
        console.error('❌ Error finding/creating customer:', err);
        throw err;
      }
    };

    const issueStoreCredit = async (customerId, amount, reason) => {
      try {
        const mutation = `
          mutation StoreCreditAccountCreditCreate($input: StoreCreditAccountCreditInput!) {
            storeCreditAccountCreditCreate(input: $input) {
              storeCreditAccountTransaction {
                id
                amount {
                  amount
                  currencyCode
                }
                createdAt
                account {
                  id
                  balance {
                    amount
                    currencyCode
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const variables = {
          input: {
            customerId: `gid://shopify/Customer/${customerId}`,
            amount: {
              amount: amount.toFixed(2),
              currencyCode: "CAD"
            },
            note: reason
          }
        };

        const graphqlRes = await makeShopifyGraphQLRequest(mutation, variables);

        if (!graphqlRes.ok) {
          throw new Error(`HTTP Error ${graphqlRes.status}: ${await graphqlRes.text()}`);
        }

        const result = await graphqlRes.json();
        
        if (result.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
        }
        
        if (result.data?.storeCreditAccountCreditCreate?.userErrors?.length > 0) {
          throw new Error(`Store credit error: ${result.data.storeCreditAccountCreditCreate.userErrors[0].message}`);
        }

        const transaction = result.data?.storeCreditAccountCreditCreate?.storeCreditAccountTransaction;
        
        if (!transaction) {
          throw new Error('Store credit transaction was not created');
        }

        console.log('✅ Store credit created:', transaction.id);
        return transaction;
      } catch (err) {
        console.error('❌ Store credit creation failed:', err);
        throw err;
      }
    };

    // Process cards with enhanced tag search and exact inventory updates
    const processingResult = await processTradeCards(cards, estimateMode, locationId);
    const { results, totals, inventoryUpdates } = processingResult;

    // Calculate final payout
    const finalPayout = validatedOverride !== null ? validatedOverride : totals.totalSuggestedValue;
    const overrideUsed = validatedOverride !== null;

    console.log('💰 Final calculations:', {
      totalSuggestedValue: totals.totalSuggestedValue,
      totalMaximumValue: totals.totalMaximumValue,
      totalRetailValue: totals.totalRetailValue,
      finalPayout,
      overrideUsed,
      inventoryUpdatesAttempted: results.filter(r => r.match).length,
      inventoryUpdatesSuccessful: results.filter(r => r.inventoryUpdated).length,
      inventoryUpdateFailures: results.filter(r => r.match && !r.inventoryUpdated).length
    });

    // Handle payouts (only if not estimate mode)
    let giftCardCode = null;
    let storeCreditTransaction = null;
    let customer = null;

    if (!estimateMode && finalPayout > 0) {
      if (payoutMethod === "store-credit") {
        try {
          customer = await findOrCreateCustomer(customerEmail);
          const reason = `Trade-in payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override)` : ''}`;
          storeCreditTransaction = await issueStoreCredit(customer.id, finalPayout, reason);
          console.log(`✅ Store credit issued: ${finalPayout} to ${customerEmail}`);
        } catch (err) {
          console.error("❌ Store credit failed:", err);
          return res.status(500).json({ 
            error: "Store credit creation failed", 
            details: err.message
          });
        }
      } else if (payoutMethod === "gift-card") {
        try {
          const giftCardRes = await makeShopifyRequest('/admin/api/2023-10/gift_cards.json', {
            method: "POST",
            body: JSON.stringify({
              gift_card: {
                initial_value: finalPayout.toFixed(2),
                note: `Trade-in payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override)` : ''}`,
                currency: "CAD"
              }
            })
          });
          
          if (!giftCardRes.ok) {
            throw new Error(await giftCardRes.text());
          }
          
          const giftCardData = await giftCardRes.json();
          giftCardCode = giftCardData?.gift_card?.code;
          
          console.log(`✅ Gift card created: ${finalPayout}, Code: ${giftCardCode}`);
        } catch (err) {
          console.error("❌ Gift card failed:", err);
          return res.status(500).json({ 
            error: "Gift card creation failed", 
            details: err.message 
          });
        }
      } else if (payoutMethod === "cash") {
        console.log(`💵 Cash payout: ${finalPayout} for ${employeeName}`);
      }
    }

    // Return response with enhanced debugging information
    const response = {
      success: true,
      estimate: estimateMode,
      employeeName,
      payoutMethod,
      customerEmail,
      results,
      suggestedTotal: totals.totalSuggestedValue.toFixed(2),
      maximumTotal: totals.totalMaximumValue.toFixed(2),
      totalRetailValue: totals.totalRetailValue.toFixed(2),
      finalPayout: finalPayout.toFixed(2),
      overrideUsed,
      overrideAmount: overrideUsed ? finalPayout.toFixed(2) : null,
      giftCardCode,
      storeCreditTransaction: storeCreditTransaction ? {
        id: storeCreditTransaction.id,
        amount: storeCreditTransaction.amount,
        createdAt: storeCreditTransaction.createdAt
      } : null,
      customer: customer ? {
        id: customer.id,
        email: customer.email,
        name: `${customer.first_name} ${customer.last_name}`
      } : null,
      timestamp: new Date().toISOString(),
      processingStats: {
        totalCards: cards.length,
        cardsFound: results.filter(r => r.match).length,
        cardsNotFound: results.filter(r => !r.match).length,
        inventoryUpdatesSuccessful: results.filter(r => r.inventoryUpdated).length,
        inventoryUpdatesFailed: results.filter(r => r.match && !r.inventoryUpdated).length
      },
      // Enhanced debug info
      debug: {
        exactSkuMatches: results.filter(r => r.searchMethod === 'exact_sku').length,
        titleMatches: results.filter(r => r.searchMethod === 'title').length,
        skuMatches: results.filter(r => r.searchMethod === 'sku').length,
        tagMatches: results.filter(r => r.searchMethod?.startsWith('tag')).length,
        uncertainMatches: results.filter(r => r.confidence === 'low' || r.confidence === 'medium').length,
        multipleOptionsAvailable: results.filter(r => r.alternativeCount > 0).length,
        searchMethodBreakdown: results.reduce((acc, r) => {
          acc[r.searchMethod] = (acc[r.searchMethod] || 0) + 1;
          return acc;
        }, {}),
        confidenceBreakdown: results.reduce((acc, r) => {
          if (r.confidence) {
            acc[r.confidence] = (acc[r.confidence] || 0) + 1;
          }
          return acc;
        }, {}),
        apiCredentialsUsed: {
          domain: SHOPIFY_DOMAIN,
          apiKeyPresent: !!SHOPIFY_API_KEY,
          apiSecretPresent: !!SHOPIFY_API_SECRET,
          accessTokenPresent: !!SHOPIFY_ACCESS_TOKEN
        }
      }
    };

    console.log('✅ Processing complete');
    console.log('🔑 API Credentials Status:', response.debug.apiCredentialsUsed);
    console.log('🎯 Search method breakdown:', response.debug.searchMethodBreakdown);
    console.log('🏷️ Tag matches:', response.debug.tagMatches);
    console.log('⚠️ Uncertain matches:', response.debug.uncertainMatches);
    console.log('🔀 Multiple options available:', response.debug.multipleOptionsAvailable);
    console.log('=== API REQUEST END ===');
    
    res.status(200).json(response);

  } catch (err) {
    console.error("💥 API ERROR:", err);
    return res.status(500).json({ 
      error: "Internal server error", 
      details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  }
};
