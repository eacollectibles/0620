// Enhanced search optimizer class
class SearchOptimizer {
  constructor() {
    this.searchCache = new Map();
    this.pendingSearches = new Map();
    this.maxCacheSize = 1000;
    this.cacheTimeout = 300000; // 5 minutes
  }

  // Main search method with caching and deduplication
  async searchCard(query, options = {}) {
    const cacheKey = `${query.toLowerCase().trim()}_${options.estimate || false}`;
    
    // Return cached result if available and not expired
    if (this.searchCache.has(cacheKey)) {
      const cached = this.searchCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log('🎯 Cache hit for:', query);
        return cached.result;
      } else {
        this.searchCache.delete(cacheKey);
      }
    }
    
    // Return pending search if already in progress
    if (this.pendingSearches.has(cacheKey)) {
      console.log('⏳ Waiting for pending search:', query);
      return this.pendingSearches.get(cacheKey);
    }
    
    // Start new search
    const searchPromise = this.executeOptimizedSearch(query, options);
    this.pendingSearches.set(cacheKey, searchPromise);
    
    try {
      const result = await searchPromise;
      
      // Cache successful results
      this.cacheResult(cacheKey, result);
      
      return result;
    } finally {
      this.pendingSearches.delete(cacheKey);
    }
  }

  async executeOptimizedSearch(query, options) {
    const strategies = this.getOptimizedStrategies(query);
    const timeout = options.estimate ? 3000 : 10000;
    
    // Try strategies with intelligent ordering and early exit
    for (const strategy of strategies) {
      try {
        const result = await Promise.race([
          this.performSearchStrategy(strategy, query, options),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), timeout)
          )
        ]);
        
        if (result && result.found) {
          console.log(`✅ Found via ${strategy}:`, query);
          return result;
        }
      } catch (error) {
        console.log(`❌ Search strategy ${strategy} failed for ${query}:`, error.message);
        continue;
      }
    }
    
    // Return not found result
    console.log(`❌ No results found for:`, query);
    return {
      found: false,
      query,
      searchMethod: 'none',
      name: query,
      sku: 'NOT-FOUND',
      retailPrice: 0,
      suggestedTrade: 0,
      maxTrade: 0
    };
  }

  getOptimizedStrategies(query) {
    const strategies = [];
    
    // Smart strategy selection based on query pattern
    if (/^[A-Z0-9-]{6,}$/i.test(query)) {
      // Looks like a SKU pattern
      strategies.push('sku', 'title', 'tag');
    } else if (query.includes('#') || /\d+\/\d+/.test(query)) {
      // Looks like card number or set number
      strategies.push('tag', 'sku', 'title');
    } else if (query.length < 10) {
      // Short query, likely partial name
      strategies.push('title', 'tag', 'sku');
    } else {
      // Full card name
      strategies.push('title', 'sku', 'tag');
    }
    
    return strategies;
  }

  async performSearchStrategy(strategy, query, options) {
    // This will be implemented with the actual Shopify API calls
    // Integration point for existing search functions
    switch (strategy) {
      case 'title':
        return await this.searchByTitle(query, options);
      case 'sku':
        return await this.searchBySKU(query, options);
      case 'tag':
        return await this.searchByTag(query, options);
      default:
        return null;
    }
  }

  // Placeholder methods - will be integrated with actual Shopify calls
  async searchByTitle(query, options) {
    // Will be replaced with actual title search implementation
    return null;
  }

  async searchBySKU(query, options) {
    // Will be replaced with actual SKU search implementation
    return null;
  }

  async searchByTag(query, options) {
    // Will be replaced with actual tag search implementation
    return null;
  }

  cacheResult(key, result) {
    // Implement LRU cache behavior
    if (this.searchCache.size >= this.maxCacheSize) {
      const oldestKey = this.searchCache.keys().next().value;
      this.searchCache.delete(oldestKey);
    }
    
    this.searchCache.set(key, {
      result,
      timestamp: Date.now()
    });
  }

  clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.searchCache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.searchCache.delete(key);
      }
    }
  }
}

// Initialize global search optimizer
const globalSearchOptimizer = new SearchOptimizer();

module.exports = async function handler(req, res) {
  // 🔧 ADD CORS HEADERS FIRST
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // 🔧 HANDLE OPTIONS PREFLIGHT
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS request received - sending CORS headers');
    return res.status(200).end();
  }

  // 🔧 LOG ALL REQUESTS
  console.log('=== API REQUEST START ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', req.headers);
  console.log('Query:', req.query);
  console.log('Body:', req.body);

  try {
    if (req.method !== 'POST') {
      console.log('❌ Method not allowed:', req.method);
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const estimateMode = req.query?.estimate === 'true';
    console.log('🔍 Estimate mode:', estimateMode);
    
    const { cards, employeeName, payoutMethod, overrideTotal, customerEmail } = req.body;
    
    console.log('📋 Parsed request data:', {
      cardsCount: cards?.length,
      employeeName,
      payoutMethod,
      overrideTotal,
      customerEmail,
      estimateMode
    });

    // 🆕 DETECT SEARCH PREVIEW MODE
    const isSearchPreview = employeeName === 'Preview' || estimateMode;
    console.log('🔍 Search preview mode:', isSearchPreview);

    // 🆕 SKIP VALIDATIONS FOR SEARCH PREVIEWS
    let validatedOverride = null;
    
    if (!isSearchPreview) {
      // Add customer email validation for store credit
      if (payoutMethod === "store-credit" && !customerEmail) {
        console.log('❌ Missing customer email for store credit');
        return res.status(400).json({ error: 'Customer email is required for store credit payouts' });
      }

      // Validate override total if provided
      if (overrideTotal !== undefined && overrideTotal !== null && overrideTotal !== '') {
        const override = parseFloat(overrideTotal);
        if (isNaN(override)) {
          console.log('❌ Invalid override total:', overrideTotal);
          return res.status(400).json({ error: 'Override total must be a valid number' });
        }
        if (override < 0) {
          console.log('❌ Negative override total:', override);
          return res.status(400).json({ error: 'Override total cannot be negative' });
        }
        // Store credit limit is $10,000 USD ≈ $13,500 CAD
        if (override > 13500) {
          console.log('❌ Override total too high:', override);
          return res.status(400).json({ error: 'Override total exceeds maximum allowed limit ($13,500 CAD)' });
        }
        validatedOverride = override;
        console.log('✅ Validated override:', validatedOverride);
      }

      // Prevent overrides in estimate mode (optional business rule)
      if (estimateMode && validatedOverride !== null) {
        console.log('❌ Override not allowed in estimate mode');
        return res.status(400).json({ error: 'Override total not allowed in estimate mode' });
      }
    }

    if (!cards || !Array.isArray(cards)) {
      console.log('❌ Invalid cards array:', cards);
      return res.status(400).json({ error: 'Invalid or missing cards array' });
    }

    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

    console.log('🛍️ Shopify config:', {
      domain: SHOPIFY_DOMAIN,
      hasToken: !!ACCESS_TOKEN
    });

    // NEW: Store credit helper functions
    const findOrCreateCustomer = async (email) => {
      try {
        console.log('🔍 Finding customer:', email);
        
        // First, try to find existing customer
        const searchRes = await fetch(
          `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`,
          {
            headers: {
              'X-Shopify-Access-Token': ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          }
        );
        
        const searchData = await searchRes.json();
        console.log('👤 Customer search result:', {
          found: searchData.customers?.length > 0,
          count: searchData.customers?.length
        });
        
        if (searchData.customers && searchData.customers.length > 0) {
          console.log('✅ Existing customer found');
          return searchData.customers[0];
        }

        console.log('➕ Creating new customer');
        
        // If customer doesn't exist, create one
        const createRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/customers.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          },
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
          const errorText = await createRes.text();
          console.log('❌ Customer creation failed:', errorText);
          throw new Error(`Failed to create customer: ${errorText}`);
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
        console.log('💳 Issuing store credit:', { customerId, amount, reason });
        
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

        console.log('📤 GraphQL mutation variables:', variables);

        const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ 
            query: mutation,
            variables: variables
          })
        });

        const result = await graphqlRes.json();
        
        console.log('📥 GraphQL Response:', JSON.stringify(result, null, 2));
        console.log('💳 Store credit mutation result:', {
          hasData: !!result.data,
          hasStoreCreditCreate: !!result.data?.storeCreditAccountCreditCreate,
          hasTransaction: !!result.data?.storeCreditAccountCreditCreate?.storeCreditAccountTransaction,
          hasErrors: !!result.data?.storeCreditAccountCreditCreate?.userErrors?.length,
          errors: result.data?.storeCreditAccountCreditCreate?.userErrors,
          graphqlErrors: result.errors
        });
        
        if (result.errors) {
          console.log('❌ GraphQL errors:', result.errors);
          throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
        }
        
        if (result.data?.storeCreditAccountCreditCreate?.userErrors?.length > 0) {
          console.log('❌ Store credit user errors:', result.data.storeCreditAccountCreditCreate.userErrors);
          throw new Error(`Store credit error: ${result.data.storeCreditAccountCreditCreate.userErrors[0].message}`);
        }

        const transaction = result.data?.storeCreditAccountCreditCreate?.storeCreditAccountTransaction;
        
        if (!transaction) {
          console.log('❌ No transaction returned');
          throw new Error('Store credit transaction was not created - no transaction returned');
        }

        console.log('✅ Store credit issued successfully:', transaction.id);
        return transaction;
      } catch (err) {
        console.error('❌ Error issuing store credit:', err);
        throw err;
      }
    };

    // NEW: Chronological tracking array
    const chronologicalLog = [];
    
    // Helper function to add chronological entry
    function addChronologicalEntry(cardName, inputSku, action, result = null, variantSku = null, productTitle = null, searchMethod = null) {
      const entry = {
        timestamp: new Date().toISOString(),
        processingOrder: chronologicalLog.length + 1,
        cardName,
        inputSku,
        action,
        result,
        variantSku,
        productTitle,
        searchMethod,
        processingTime: Date.now()
      };
      chronologicalLog.push(entry);
      console.log(`📝 Log entry: ${action} - ${cardName}`);
    }

    // Trade rate calculation functions
    function calculateMaximumTradeValue(marketValue) {
      const price = parseFloat(marketValue);
      
      if (price >= 50.00) {
        return parseFloat((price * 0.75).toFixed(2)); // 75%
      } else if (price >= 25.00) {
        return parseFloat((price * 0.70).toFixed(2)); // 70%
      } else if (price >= 15.01) {
        return parseFloat((price * 0.65).toFixed(2)); // 65%
      } else if (price >= 8.00) {
        return parseFloat((price * 0.50).toFixed(2)); // 50%
      } else if (price >= 5.00) {
        return parseFloat((price * 0.35).toFixed(2)); // 35%
      } else if (price >= 3.01) {
        return parseFloat((price * 0.25).toFixed(2)); // 25%
      } else if (price >= 2.00) {
        return 0.50; // Flat $0.50
      } else if (price >= 0.01) {
        return 0.01; // Flat $0.01 for items under $2.00
      } else {
        return 0; // No trade value for $0 items
      }
    }

    function calculateSuggestedTradeValue(marketValue) {
      const price = parseFloat(marketValue);
      
      if (price >= 50.00) {
        return parseFloat((price * 0.75).toFixed(2)); // 75%
      } else if (price >= 25.00) {
        return parseFloat((price * 0.50).toFixed(2)); // 50%
      } else if (price >= 15.01) {
        return parseFloat((price * 0.35).toFixed(2)); // 35%
      } else if (price >= 8.00) {
        return parseFloat((price * 0.40).toFixed(2)); // 40%
      } else if (price >= 5.00) {
        return parseFloat((price * 0.35).toFixed(2)); // 35%
      } else if (price >= 3.01) {
        return parseFloat((price * 0.25).toFixed(2)); // 25%
      } else if (price >= 2.00) {
        return 0.10; // Flat $0.10
      } else if (price >= 0.01) {
        return 0.01; // Flat $0.01 for items under $2.00
      } else {
        return 0; // No trade value for $0 items
      }
    }

    // 🆕 SKIP LOCATION ID LOOKUP FOR SEARCH PREVIEWS
    let locationId = null;
    if (!estimateMode && !isSearchPreview) {
      try {
        console.log('📍 Getting location ID...');
        const locationRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/locations.json`, {
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        const locations = await locationRes.json();
        locationId = locations.locations?.[0]?.id;
        console.log('📍 Location ID:', locationId);
      } catch (err) {
        console.error('❌ Failed to get location ID:', err);
      }
    }

    // 🆕 OPTIMIZED SEARCH FUNCTIONS - Updated to work with SearchOptimizer
    const fetchVariantBySKU = async (sku) => {
      console.log('🔍 Fetching variant by SKU:', sku);
      
      const query = `
        {
          productVariants(first: 1, query: "sku:${sku}") {
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
                  title
                }
              }
            }
          }
        }
      `;

      const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query })
      });

      const json = await graphqlRes.json();
      const variantEdge = json?.data?.productVariants?.edges?.[0];
      const result = variantEdge?.node || null;
      
      console.log('🔍 SKU search result:', !!result);
      return result;
    };

    const fetchVariantByTag = async (tag) => {
      console.log('🏷️ Fetching variant by tag:', tag);
      
      const query = `
        {
          products(first: 1, query: "tag:${tag}") {
            edges {
              node {
                id
                title
                variants(first: 1) {
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
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query })
      });

      const json = await graphqlRes.json();
      const productEdge = json?.data?.products?.edges?.[0];
      
      if (productEdge?.node?.variants?.edges?.[0]) {
        const product = productEdge.node;
        const variant = product.variants.edges[0].node;
        
        const result = {
          price: variant.price,
          inventory_item_id: variant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', ''),
          product: {
            title: product.title
          },
          sku: variant.sku
        };
        
        console.log('🏷️ Tag search result: found');
        return result;
      }
      
      console.log('🏷️ Tag search result: not found');
      return null;
    };

    // 🆕 INTEGRATE SEARCH OPTIMIZER WITH EXISTING SEARCH METHODS
    // Override the search optimizer methods with actual Shopify implementations
    globalSearchOptimizer.searchByTitle = async (query, options) => {
      console.log('🔍 Optimized search by title:', query);
      
      const productRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?title=${encodeURIComponent(query)}`,
        {
          method: 'GET',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      const productText = await productRes.text();
      let productData;

      try {
        productData = JSON.parse(productText);
      } catch (err) {
        throw new Error(`Failed to parse product data: ${err.message}`);
      }

      if (productData && productData.products && productData.products.length > 0) {
        const match = productData.products[0];
        const variant = match.variants[0];
        
        return {
          found: true,
          name: match.title,
          sku: variant.sku,
          retailPrice: parseFloat(variant.price || 0),
          suggestedTrade: calculateSuggestedTradeValue(variant.price),
          maxTrade: calculateMaximumTradeValue(variant.price),
          searchMethod: 'title',
          variant: variant,
          productTitle: match.title
        };
      }
      
      return null;
    };

    globalSearchOptimizer.searchBySKU = async (query, options) => {
      console.log('🔍 Optimized search by SKU:', query);
      
      const matchedVariant = await fetchVariantBySKU(query);
      if (matchedVariant) {
        return {
          found: true,
          name: matchedVariant.product.title,
          sku: matchedVariant.sku,
          retailPrice: parseFloat(matchedVariant.price || 0),
          suggestedTrade: calculateSuggestedTradeValue(matchedVariant.price),
          maxTrade: calculateMaximumTradeValue(matchedVariant.price),
          searchMethod: 'sku',
          variant: {
            price: matchedVariant.price,
            inventory_item_id: matchedVariant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
          },
          productTitle: matchedVariant.product.title
        };
      }
      
      return null;
    };

    globalSearchOptimizer.searchByTag = async (query, options) => {
      console.log('🔍 Optimized search by tag:', query);
      
      const tagVariant = await fetchVariantByTag(query);
      if (tagVariant) {
        return {
          found: true,
          name: tagVariant.product.title,
          sku: tagVariant.sku,
          retailPrice: parseFloat(tagVariant.price || 0),
          suggestedTrade: calculateSuggestedTradeValue(tagVariant.price),
          maxTrade: calculateMaximumTradeValue(tagVariant.price),
          searchMethod: 'tag',
          variant: {
            price: tagVariant.price,
            inventory_item_id: tagVariant.inventory_item_id
          },
          productTitle: tagVariant.product.title
        };
      }
      
      return null;
    };

    let totalSuggestedValue = 0;
    let totalMaximumValue = 0;
    let totalRetailValue = 0;
    const results = [];

    // NEW: Add processing start timestamp
    const processingStartTime = Date.now();
    console.log('⏱️ Processing started for', cards.length, 'cards');

    // 🆕 ADD SEARCH TIMEOUT PROTECTION
    const SEARCH_TIMEOUT = isSearchPreview ? 5000 : 30000; // 5s for previews, 30s for real trades
    const searchStartTime = Date.now();

    // 🆕 OPTIMIZED CARD PROCESSING LOOP
    for (const card of cards) {
      // 🆕 CHECK FOR TIMEOUT
      if (Date.now() - searchStartTime > SEARCH_TIMEOUT) {
        console.log('⏰ Search timeout reached, returning partial results');
        addChronologicalEntry('TIMEOUT', null, 'SEARCH_TIMEOUT', 'Search timeout reached, partial results returned');
        break;
      }

      const { cardName, sku = null, quantity = 1 } = card;
      const cardStartTime = Date.now();
      
      console.log(`🃏 Processing card: ${cardName} (SKU: ${sku}, Qty: ${quantity})`);
      
      // Log the start of processing this card
      addChronologicalEntry(cardName, sku, 'PROCESSING_START', 'Starting optimized card lookup process');
      
      let searchResult = null;
      let variant = null;
      let productTitle = null;
      let productSku = null;
      let searchMethod = null;

      try {
        // 🆕 USE OPTIMIZED SEARCH
        console.log('🚀 Using optimized search for:', cardName);
        searchResult = await globalSearchOptimizer.searchCard(cardName || sku, { 
          estimate: isSearchPreview 
        });

        if (searchResult && searchResult.found) {
          variant = searchResult.variant;
          productTitle = searchResult.productTitle;
          productSku = searchResult.sku;
          searchMethod = searchResult.searchMethod;
          
          console.log(`✅ Optimized search found: ${productTitle} via ${searchMethod}`);
          
          addChronologicalEntry(
            cardName,
            sku,
            `FOUND_BY_${searchMethod.toUpperCase()}`,
            `Product found by optimized ${searchMethod} search`,
            productSku,
            productTitle,
            searchMethod
          );
        } else {
          // No match found by optimized search
          console.log('❌ No match found by optimized search');
          addChronologicalEntry(
            cardName,
            sku,
            'NO_MATCH_FOUND',
            'No product found by optimized search methods',
            null,
            null,
            'none'
          );
          
          results.push({
            cardName,
            match: null,
            retailPrice: 0,
            suggestedTradeValue: 0,
            maximumTradeValue: 0,
            quantity,
            sku: null,
            searchMethod: 'none'
          });
          continue;
        }
      } catch (searchError) {
        console.error(`❌ Optimized search error for ${cardName}:`, searchError);
        addChronologicalEntry(cardName, sku, 'SEARCH_ERROR', `Search error: ${searchError.message}`);
        
        results.push({
          cardName,
          match: null,
          retailPrice: 0,
          suggestedTradeValue: 0,
          maximumTradeValue: 0,
          quantity,
          sku: null,
          searchMethod: 'none'
        });
        continue;
      }

      if (!variant) {
        console.log('❌ Variant is null despite search results');
        addChronologicalEntry(cardName, sku, 'VARIANT_ERROR', 'Variant data is null despite search results');
        
        results.push({
          cardName,
          match: null,
          retailPrice: 0,
          suggestedTradeValue: 0,
          maximumTradeValue: 0,
          quantity,
          sku: null,
          searchMethod: 'none'
        });
        continue;
      }

      const variantPrice = parseFloat(variant.price || 0);
      const suggestedTradeValue = calculateSuggestedTradeValue(variantPrice);
      const maximumTradeValue = calculateMaximumTradeValue(variantPrice);
      
      totalSuggestedValue += suggestedTradeValue * quantity;
      totalMaximumValue += maximumTradeValue * quantity;
      totalRetailValue += variantPrice * quantity;

      console.log(`💰 Trade values for ${cardName}: Retail: $${variantPrice}, Suggested: $${suggestedTradeValue}, Maximum: $${maximumTradeValue}`);

      // Log successful processing with trade values calculated
      addChronologicalEntry(
        cardName,
        sku,
        'PROCESSING_COMPLETE',
        `Trade values calculated: Retail: $${variantPrice}, Suggested: $${suggestedTradeValue}, Maximum: $${maximumTradeValue}`,
        productSku,
        productTitle,
        searchMethod
      );

      // 🆕 SKIP INVENTORY UPDATES FOR SEARCH PREVIEWS
      // Update inventory if not in estimate mode AND not a search preview
      if (!estimateMode && !isSearchPreview && locationId && variant.inventory_item_id) {
        try {
          console.log(`📦 Updating inventory for ${cardName}: +${quantity}`);
          
          const adjustRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/inventory_levels/adjust.json`, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': ACCESS_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              location_id: locationId,
              inventory_item_id: variant.inventory_item_id,
              available_adjustment: parseInt(quantity)
            })
          });
          
          if (adjustRes.ok) {
            const adjustData = await adjustRes.json();
            console.log(`✅ Inventory updated for ${cardName}: +${quantity}, new total: ${adjustData.inventory_level?.available || 'unknown'}`);
            
            addChronologicalEntry(
              cardName,
              sku,
              'INVENTORY_UPDATED',
              `Inventory increased by ${quantity}`,
              productSku,
              productTitle,
              searchMethod
            );
          } else {
            const errorText = await adjustRes.text();
            console.error(`❌ Failed to update inventory for ${cardName}:`, errorText);
            
            addChronologicalEntry(
              cardName,
              sku,
              'INVENTORY_UPDATE_FAILED',
              'Failed to update inventory',
              productSku,
              productTitle,
              searchMethod
            );
          }
        } catch (inventoryErr) {
          console.error(`❌ Failed to update inventory for ${cardName}:`, inventoryErr);
          
          addChronologicalEntry(
            cardName,
            sku,
            'INVENTORY_UPDATE_ERROR',
            `Inventory update error: ${inventoryErr.message}`,
            productSku,
            productTitle,
            searchMethod
          );
        }
      }

      results.push({
        cardName,
        match: productTitle,
        retailPrice: variantPrice,
        suggestedTradeValue,
        maximumTradeValue,
        quantity,
        sku: productSku,
        searchMethod
      });
    }

    // Calculate processing time for each entry
    chronologicalLog.forEach((entry, index) => {
      if (index === 0) {
        entry.processingDuration = 0;
      } else {
        entry.processingDuration = entry.processingTime - chronologicalLog[0].processingTime;
      }
    });

    // Calculate final payout - use override if provided, otherwise suggested total
    const finalPayout = validatedOverride !== null ? validatedOverride : totalSuggestedValue;
    const overrideUsed = validatedOverride !== null;

    console.log('💰 Final calculations:', {
      totalSuggestedValue,
      totalMaximumValue,
      totalRetailValue,
      finalPayout,
      overrideUsed
    });

    // Log override usage for auditing
    if (overrideUsed && !estimateMode && !isSearchPreview) {
      console.log(`🔧 OVERRIDE USED: Employee: ${employeeName || 'Unknown'}, Suggested: ${totalSuggestedValue.toFixed(2)}, Override: ${finalPayout.toFixed(2)}, Difference: ${(finalPayout - totalSuggestedValue).toFixed(2)}`);
    }

    // 🆕 LOG SEARCH OPTIMIZATION STATS
    const searchStats = results.reduce((acc, result) => {
      acc[result.searchMethod] = (acc[result.searchMethod] || 0) + 1;
      return acc;
    }, {});
    console.log(`📊 Optimized search method statistics:`, searchStats);
    console.log(`🎯 Cache statistics:`, {
      cacheSize: globalSearchOptimizer.searchCache.size,
      pendingSearches: globalSearchOptimizer.pendingSearches.size
    });

    // Clean expired cache entries periodically
    if (Math.random() < 0.1) { // 10% chance to clean cache
      globalSearchOptimizer.clearExpiredCache();
    }

    // 🆕 SKIP PAYOUT PROCESSING FOR SEARCH PREVIEWS
    // Handle store credit, gift card, or cash payouts
    let giftCardCode = null;
    let storeCreditTransaction = null;
    let customer = null;

    if (!estimateMode && !isSearchPreview && finalPayout > 0) {
      console.log('💳 Processing payout:', { payoutMethod, finalPayout });
      
      if (payoutMethod === "store-credit") {
        try {
          // Find or create customer
          customer = await findOrCreateCustomer(customerEmail);
          console.log('👤 Customer found/created:', {
            id: customer.id,
            email: customer.email,
            gid: `gid://shopify/Customer/${customer.id}`
          });
          
          // Issue store credit using new native feature
          const reason = `Trade-in payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override: ${finalPayout.toFixed(2)}, Suggested: ${totalSuggestedValue.toFixed(2)})` : ''}`;
          
          console.log('💳 Attempting store credit with:', {
            customerId: customer.id,
            amount: finalPayout,
            reason: reason
          });
          
          storeCreditTransaction = await issueStoreCredit(customer.id, finalPayout, reason);
          
          console.log(`✅ Store credit issued: ${finalPayout.toFixed(2)} CAD to ${customerEmail}`);
          
        } catch (err) {
          console.error("❌ Store credit creation failed:", err);
          console.error("❌ Store credit error details:", {
            message: err.message,
            customerEmail: customerEmail,
            customerId: customer?.id,
            amount: finalPayout
          });
          
          // Return error instead of silent fallback
          return res.status(500).json({ 
            error: "Store credit creation failed", 
            details: err.message,
            fallbackAvailable: true
          });
        }
      } else if (payoutMethod === "gift-card") {
        try {
          console.log('🎁 Creating gift card...');
          
          const giftCardRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/gift_cards.json`, {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": ACCESS_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              gift_card: {
                initial_value: finalPayout.toFixed(2),
                note: `Trade-in payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override: ${finalPayout.toFixed(2)}, Suggested: ${totalSuggestedValue.toFixed(2)})` : ''}`,
                currency: "CAD"
              }
            })
          });
          
          if (!giftCardRes.ok) {
            const errorText = await giftCardRes.text();
            console.error("❌ Gift card creation failed:", errorText);
            return res.status(500).json({ 
              error: "Gift card creation failed", 
              details: errorText 
            });
          }
          
          const giftCardData = await giftCardRes.json();
          giftCardCode = giftCardData?.gift_card?.code || null;
          
          console.log(`✅ Gift card created: ${finalPayout.toFixed(2)} CAD, Code: ${giftCardCode}`);
          
        } catch (giftCardErr) {
          console.error("❌ Gift card creation failed:", giftCardErr);
          return res.status(500).json({ 
            error: "Gift card creation failed", 
            details: giftCardErr.message 
          });
        }
      } else if (payoutMethod === "cash") {
        // For cash payouts, no gift card or store credit needed
        console.log(`💵 Cash payout: ${finalPayout.toFixed(2)} CAD for ${employeeName || "Unknown"}`);
      }
    }

    // NEW: Create a summary of found cards in chronological order
    const chronologicalCardsSummary = chronologicalLog
      .filter(entry => entry.action.startsWith('FOUND_BY_'))
      .map((entry, index) => ({
        order: index + 1,
        timestamp: entry.timestamp,
        cardName: entry.cardName,
        variantSku: entry.variantSku,
        productTitle: entry.productTitle,
        searchMethod: entry.searchMethod,
        processingDuration: entry.processingDuration
      }));

    console.log('✅ Optimized processing complete:', {
      totalCards: cards.length,
      cardsFound: chronologicalCardsSummary.length,
      cardsNotFound: cards.length - chronologicalCardsSummary.length,
      totalProcessingTime: Date.now() - processingStartTime,
      cacheHits: Array.from(globalSearchOptimizer.searchCache.values()).length
    });

    // 🆕 ENHANCED RESPONSE WITH SEARCH OPTIMIZATIONS
    // Return comprehensive response with chronological data and optimization metrics
    const response = {
      success: true,
      
      // 🆕 Search optimization metrics
      isSearchPreview: isSearchPreview,
      searchPerformance: {
        totalSearchTime: Date.now() - processingStartTime,
        averageTimePerCard: Math.round((Date.now() - processingStartTime) / cards.length),
        fastResponse: (Date.now() - processingStartTime) < 2000, // Under 2 seconds
        timeoutReached: chronologicalLog.some(entry => entry.action === 'SEARCH_TIMEOUT'),
        cacheHitRate: globalSearchOptimizer.searchCache.size > 0 ? 
          ((globalSearchOptimizer.searchCache.size / cards.length) * 100).toFixed(1) + '%' : '0%',
        optimizationUsed: true
      },
      
      // Payment method details (only for real trades)
      giftCardCode: isSearchPreview ? null : giftCardCode,
      storeCreditTransaction: isSearchPreview ? null : (storeCreditTransaction ? {
        id: storeCreditTransaction.id,
        amount: storeCreditTransaction.amount,
        createdAt: storeCreditTransaction.createdAt
      } : null),
      customer: isSearchPreview ? null : (customer ? {
        id: customer.id,
        email: customer.email,
        name: `${customer.first_name} ${customer.last_name}`
      } : null),
      
      // Transaction details
      estimate: estimateMode,
      employeeName,
      payoutMethod,
      customerEmail: isSearchPreview ? null : customerEmail,
      results,
      suggestedTotal: totalSuggestedValue.toFixed(2),
      maximumTotal: totalMaximumValue.toFixed(2),
      totalRetailValue: totalRetailValue.toFixed(2),
      finalPayout: finalPayout.toFixed(2),
      overrideUsed: isSearchPreview ? false : overrideUsed,
      overrideAmount: (isSearchPreview || !overrideUsed) ? null : finalPayout.toFixed(2),
      overrideDifference: (isSearchPreview || !overrideUsed) ? null : (finalPayout - totalSuggestedValue).toFixed(2),
      timestamp: new Date().toISOString(),
      
      // Chronological tracking data (simplified for search previews)
      chronologicalLog: isSearchPreview ? chronologicalLog.filter(entry => 
        entry.action.includes('SEARCH') || entry.action.includes('FOUND') || entry.action.includes('NO_MATCH')
      ) : chronologicalLog,
      chronologicalCardsSummary: chronologicalCardsSummary,
      processingStats: {
        totalCards: cards.length,
        cardsFound: chronologicalCardsSummary.length,
        cardsNotFound: cards.length - chronologicalCardsSummary.length,
        totalProcessingTime: Date.now() - processingStartTime,
        searchMethodBreakdown: searchStats,
        // 🆕 Enhanced search optimization metrics
        searchOptimizations: {
          skippedValidations: isSearchPreview,
          skippedInventoryUpdates: isSearchPreview,
          skippedPayoutProcessing: isSearchPreview,
          searchTimeout: SEARCH_TIMEOUT,
          fastSearchMode: isSearchPreview,
          cacheEnabled: true,
          cacheSize: globalSearchOptimizer.searchCache.size,
          strategicSearchUsed: true,
          parallelProcessingCapable: true
        }
      }
    };

    console.log('📤 Sending optimized response:', {
      success: response.success,
      resultsCount: response.results.length,
      finalPayout: response.finalPayout,
      payoutMethod: response.payoutMethod,
      isSearchPreview: response.isSearchPreview,
      searchTime: response.searchPerformance.totalSearchTime,
      cacheHitRate: response.searchPerformance.cacheHitRate,
      optimizationUsed: response.searchPerformance.optimizationUsed
    });

    console.log('=== API REQUEST END ===');
    
    res.status(200).json(response);

  } catch (err) {
    console.error("💥 FATAL API ERROR:", err);
    console.error("💥 Error stack:", err.stack);
    console.error("💥 Error details:", {
      name: err.name,
      message: err.message,
      code: err.code
    });
    
    return res.status(500).json({ 
      error: "Internal server error", 
      details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  }
};
