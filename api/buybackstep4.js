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

    // Shopify configuration from Vercel environment variables
    const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
    const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    // Validate required environment variables
    if (!SHOPIFY_DOMAIN || !ACCESS_TOKEN) {
      console.error('❌ Missing required environment variables');
      return res.status(500).json({ 
        error: 'Server configuration error',
        details: 'Missing Shopify credentials'
      });
    }

    console.log('🛍️ Shopify config:', {
      domain: SHOPIFY_DOMAIN,
      hasToken: !!ACCESS_TOKEN
    });

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

    // FIXED: Helper function to normalize card names/tags for search
    function normalizeSearchTerm(term) {
      if (!term) return '';
      
      // Convert "138/131" format to "138131" for tag searches
      const normalized = term.replace(/[\/\-\s]/g, '');
      console.log(`🔄 Normalized "${term}" to "${normalized}"`);
      return normalized;
    }

    // FIXED: Helper function to extract potential tags from card names
    function extractPotentialTags(cardName) {
      if (!cardName) return [];
      
      const tags = [];
      
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
      
      console.log(`🏷️ Extracted potential tags from "${cardName}":`, tags);
      return [...new Set(tags)]; // Remove duplicates
    }

    // Get location ID for inventory updates
    let locationId = null;
    if (!estimateMode) {
      try {
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

    // FIXED: Get variant by exact SKU - for frontend confirmed searches
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
      }`;

      const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query })
      });

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
        
        return {
          found: true,
          product: { title: variant.product.title },
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: numericInventoryItemId
          },
          searchMethod: 'exact_sku'
        };
      }
      
      console.log('🎯 Exact SKU not found');
      return { found: false };
    };

    // FIXED: Search by title with better normalization
    const searchByTitle = async (query) => {
      console.log('🔍 Searching by title:', query);
      
      const productRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?title=${encodeURIComponent(query)}`,
        {
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
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
            inventory_item_id: variant.inventory_item_id
          },
          searchMethod: 'title'
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
      }`;

      const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query })
      });

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
        
        return {
          found: true,
          product: { title: variant.product.title },
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: numericInventoryItemId
          },
          searchMethod: 'sku'
        };
      }
      
      return { found: false };
    };

    // FIXED: Search by tag with improved format handling
    const searchByTag = async (tag) => {
      console.log('🏷️ Searching by tag:', tag);
      
      // Normalize the tag for search (remove slashes, etc.)
      const normalizedTag = normalizeSearchTerm(tag);
      
      const query = `{
        products(first: 5, query: "tag:${normalizedTag}") {
          edges {
            node {
              id
              title
              tags
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
      }`;

      const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query })
      });

      const json = await graphqlRes.json();
      console.log(`🏷️ Tag search for "${normalizedTag}" response:`, JSON.stringify(json, null, 2));
      
      const productEdge = json?.data?.products?.edges?.[0];
      
      if (productEdge?.node?.variants?.edges?.[0]) {
        const product = productEdge.node;
        const variant = product.variants.edges[0].node;
        
        console.log(`🏷️ Tag search found:`, {
          title: product.title,
          tags: product.tags,
          sku: variant.sku,
          price: variant.price
        });
        
        return {
          found: true,
          product: { title: product.title },
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: variant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
          },
          searchMethod: 'tag'
        };
      }
      
      console.log(`🏷️ No products found with tag "${normalizedTag}"`);
      return { found: false };
    };

    // FIXED: Enhanced search with multiple tag attempts
    const searchByMultipleTags = async (cardName) => {
      console.log('🏷️ Searching by multiple tags for:', cardName);
      
      const potentialTags = extractPotentialTags(cardName);
      
      for (const tag of potentialTags) {
        if (!tag || tag.length < 2) continue;
        
        try {
          const result = await searchByTag(tag);
          if (result.found) {
            console.log(`✅ Found via tag "${tag}": ${result.product.title}`);
            return result;
          }
        } catch (error) {
          console.log(`❌ Tag search failed for "${tag}":`, error.message);
          continue;
        }
      }
      
      console.log(`❌ No matches found with any tag for: ${cardName}`);
      return { found: false };
    };

    // FIXED: Main search function with enhanced tag search
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
      
      // PRIORITY 2: Try multiple tag searches (most likely to work for your format)
      const tagResult = await searchByMultipleTags(cardName);
      if (tagResult.found) {
        return tagResult;
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

    // Customer and store credit functions (unchanged)
    const findOrCreateCustomer = async (email) => {
      try {
        // Search for existing customer
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
        
        if (searchData.customers?.length > 0) {
          console.log('✅ Existing customer found');
          return searchData.customers[0];
        }

        // Create new customer
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

    // Process cards with enhanced tag search
    let totalSuggestedValue = 0;
    let totalMaximumValue = 0;
    let totalRetailValue = 0;
    const results = [];

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
          searchMethod: 'none'
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

      console.log(`✅ Found: ${product.title} - ${variantPrice} (Suggested: ${suggestedTradeValue})`);
      console.log(`  - Final SKU: ${variant.sku}`);
      console.log(`  - Search Method: ${searchResult.searchMethod}`);

      // Update inventory if not in estimate mode
      if (!estimateMode && locationId && variant.inventory_item_id) {
        try {
          console.log(`📦 Updating inventory for ${cardName}:`);
          console.log(`  - Location ID: ${locationId}`);
          console.log(`  - Inventory Item ID: ${variant.inventory_item_id}`);
          console.log(`  - Quantity adjustment: +${quantity}`);
          
          const adjustRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/inventory_levels/adjust.json`, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': ACCESS_TOKEN,
              'Content-Type': 'application/json'
            },
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
          } else {
            const errorText = await adjustRes.text();
            console.error(`❌ Failed to update inventory for ${cardName}:`, errorText);
            console.error(`📦 Request details:`, {
              location_id: parseInt(locationId),
              inventory_item_id: parseInt(variant.inventory_item_id),
              available_adjustment: parseInt(quantity)
            });
          }
        } catch (inventoryErr) {
          console.error(`❌ Failed to update inventory for ${cardName}:`, inventoryErr);
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
        searchMethod: searchResult.searchMethod
      });
    }

    // Calculate final payout
    const finalPayout = validatedOverride !== null ? validatedOverride : totalSuggestedValue;
    const overrideUsed = validatedOverride !== null;

    console.log('💰 Final calculations:', {
      totalSuggestedValue,
      totalMaximumValue,
      totalRetailValue,
      finalPayout,
      overrideUsed
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
          const giftCardRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/gift_cards.json`, {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": ACCESS_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              gift_card: {
                initial_value: finalPayout.toFixed(2),
                note: `Trade-in payout for ${employeeName || "Unknown"}`,
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

    // Return response
    const response = {
      success: true,
      estimate: estimateMode,
      employeeName,
      payoutMethod,
      customerEmail,
      results,
      suggestedTotal: totalSuggestedValue.toFixed(2),
      maximumTotal: totalMaximumValue.toFixed(2),
      totalRetailValue: totalRetailValue.toFixed(2),
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
        cardsNotFound: results.filter(r => !r.match).length
      },
      // Enhanced debug info for tag searches
      debug: {
        exactSkuMatches: results.filter(r => r.searchMethod === 'exact_sku').length,
        titleMatches: results.filter(r => r.searchMethod === 'title').length,
        skuMatches: results.filter(r => r.searchMethod === 'sku').length,
        tagMatches: results.filter(r => r.searchMethod === 'tag').length,
        searchMethodBreakdown: results.reduce((acc, r) => {
          acc[r.searchMethod] = (acc[r.searchMethod] || 0) + 1;
          return acc;
        }, {})
      }
    };

    console.log('✅ Processing complete');
    console.log('🎯 Search method breakdown:', response.debug.searchMethodBreakdown);
    console.log('🏷️ Tag matches:', response.debug.tagMatches);
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
