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

    // ENHANCED: Get variant by exact SKU - for frontend confirmed searches
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

    // ENHANCED: Search by title with partial matching
    const searchByTitle = async (query) => {
      console.log('🔍 Searching by title:', query);
      
      // Try exact title match first
      let productRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?title=${encodeURIComponent(query)}`,
        {
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      let productData = await productRes.json();
      console.log('🔍 Exact title search response:', JSON.stringify(productData, null, 2));
      
      if (productData?.products?.length > 0) {
        const product = productData.products[0];
        const variant = product.variants[0];
        
        console.log('🔍 Exact title match found');
        return {
          found: true,
          product: product,
          variant: {
            sku: variant.sku,
            price: variant.price,
            inventory_item_id: variant.inventory_item_id
          },
          searchMethod: 'title_exact'
        };
      }

      // If no exact match, try partial matching using GraphQL
      const graphqlQuery = `{
        products(first: 10, query: "title:*${query}*") {
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
      }`;

      const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: graphqlQuery })
      });

      const graphqlData = await graphqlRes.json();
      console.log('🔍 Partial title search response:', JSON.stringify(graphqlData, null, 2));

      if (graphqlData?.data?.products?.edges?.length > 0) {
        const productEdge = graphqlData.data.products.edges[0];
        const product = productEdge.node;
        const variantEdge = product.variants.edges[0];
        
        if (variantEdge?.node) {
          const variant = variantEdge.node;
          const inventoryItemId = variant.inventoryItem?.id;
          const numericInventoryItemId = inventoryItemId ? inventoryItemId.replace('gid://shopify/InventoryItem/', '') : null;
          
          console.log('🔍 Partial title match found:', product.title);
          return {
            found: true,
            product: { title: product.title },
            variant: {
              sku: variant.sku,
              price: variant.price,
              inventory_item_id: numericInventoryItemId
            },
            searchMethod: 'title_partial'
          };
        }
      }
      
      return { found: false };
    };

    // NEW: Search by number patterns (like 216/182)
    const searchByNumberPattern = async (query) => {
      console.log('🔢 Searching by number pattern:', query);
      
      // Extract number patterns like "216/182", "123-456", "789 012", etc.
      const numberPatterns = query.match(/\d+[\/\-\s]\d+/g) || [];
      
      if (numberPatterns.length === 0) {
        return { found: false };
      }
      
      for (const pattern of numberPatterns) {
        console.log('🔢 Trying pattern:', pattern);
        
        // Search for this pattern in product titles
        const graphqlQuery = `{
          products(first: 5, query: "title:*${pattern}*") {
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
        }`;

        const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: graphqlQuery })
        });

        const graphqlData = await graphqlRes.json();
        
        if (graphqlData?.data?.products?.edges?.length > 0) {
          const productEdge = graphqlData.data.products.edges[0];
          const product = productEdge.node;
          const variantEdge = product.variants.edges[0];
          
          if (variantEdge?.node) {
            const variant = variantEdge.node;
            const inventoryItemId = variant.inventoryItem?.id;
            const numericInventoryItemId = inventoryItemId ? inventoryItemId.replace('gid://shopify/InventoryItem/', '') : null;
            
            console.log('✅ Number pattern match found:', product.title);
            return {
              found: true,
              product: { title: product.title },
              variant: {
                sku: variant.sku,
                price: variant.price,
                inventory_item_id: numericInventoryItemId
              },
              searchMethod: 'number_pattern'
            };
          }
        }
      }
      
      return { found: false };
    };

    // ENHANCED: Search by SKU (fallback method)
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

    // ENHANCED: Search by tag
    const searchByTag = async (tag) => {
      console.log('🏷️ Searching by tag:', tag);
      
      const query = `{
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
      const productEdge = json?.data?.products?.edges?.[0];
      
      if (productEdge?.node?.variants?.edges?.[0]) {
        const product = productEdge.node;
        const variant = product.variants.edges[0].node;
        
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
      
      return { found: false };
    };

    // NEW: Fuzzy search for close matches
    const fuzzySearch = async (query) => {
      console.log('🌀 Fuzzy searching:', query);
      
      // Break query into words and search for products containing any of them
      const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
      
      if (words.length === 0) {
        return { found: false };
      }
      
      // Try searching for products that contain any of the significant words
      const searchTerms = words.slice(0, 3); // Limit to first 3 significant words
      
      for (const term of searchTerms) {
        const graphqlQuery = `{
          products(first: 5, query: "title:*${term}*") {
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
        }`;

        const graphqlRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: graphqlQuery })
        });

        const graphqlData = await graphqlRes.json();
        
        if (graphqlData?.data?.products?.edges?.length > 0) {
          // Find the best match by counting word overlaps
          let bestMatch = null;
          let bestScore = 0;
          
          for (const productEdge of graphqlData.data.products.edges) {
            const product = productEdge.node;
            const productTitle = product.title.toLowerCase();
            
            // Score based on how many query words appear in the title
            const score = words.reduce((acc, word) => {
              return acc + (productTitle.includes(word) ? 1 : 0);
            }, 0);
            
            if (score > bestScore) {
              bestScore = score;
              bestMatch = productEdge;
            }
          }
          
          if (bestMatch && bestScore > 0) {
            const product = bestMatch.node;
            const variantEdge = product.variants.edges[0];
            
            if (variantEdge?.node) {
              const variant = variantEdge.node;
              const inventoryItemId = variant.inventoryItem?.id;
              const numericInventoryItemId = inventoryItemId ? inventoryItemId.replace('gid://shopify/InventoryItem/', '') : null;
              
              console.log(`✅ Fuzzy match found (score: ${bestScore}):`, product.title);
              return {
                found: true,
                product: { title: product.title },
                variant: {
                  sku: variant.sku,
                  price: variant.price,
                  inventory_item_id: numericInventoryItemId
                },
                searchMethod: 'fuzzy',
                matchScore: bestScore
              };
            }
          }
        }
      }
      
      return { found: false };
    };

    // ENHANCED: Main search function with enhanced search methods
    const searchCard = async (card) => {
      const { cardName, sku = null, searchMethod = null } = card;
      
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
          console.warn('⚠️ Exact SKU not found, falling back to enhanced search');
        }
      }
      
      // ENHANCED: Use multiple search strategies in order of specificity
      const searchStrategies = [
        { name: 'Title (Exact)', method: () => searchByTitle(cardName) },
        { name: 'SKU', method: () => searchBySKU(sku || cardName) },
        { name: 'Number Pattern', method: () => searchByNumberPattern(cardName) },
        { name: 'Tag', method: () => searchByTag(cardName) },
        { name: 'Fuzzy Search', method: () => fuzzySearch(cardName) }
      ];

      for (const strategy of searchStrategies) {
        try {
          console.log(`🔍 Trying strategy: ${strategy.name}`);
          const result = await strategy.method();
          if (result.found) {
            console.log(`✅ Found via ${strategy.name}: ${result.product.title}`);
            return result;
          }
        } catch (error) {
          console.log(`❌ ${strategy.name} failed:`, error.message);
          continue;
        }
      }
      
      console.log(`❌ No matches found for: ${cardName}`);
      return { found: false };
    };

    // Customer and store credit functions
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

    // ENHANCED: Process cards with exact SKU support
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
        searchMethod: searchResult.searchMethod,
        matchScore: searchResult.matchScore || null
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
      // ENHANCED: For debugging search method effectiveness
      debug: {
        exactSkuMatches: results.filter(r => r.searchMethod === 'exact_sku').length,
        titleExactMatches: results.filter(r => r.searchMethod === 'title_exact').length,
        titlePartialMatches: results.filter(r => r.searchMethod === 'title_partial').length,
        numberPatternMatches: results.filter(r => r.searchMethod === 'number_pattern').length,
        skuMatches: results.filter(r => r.searchMethod === 'sku').length,
        tagMatches: results.filter(r => r.searchMethod === 'tag').length,
        fuzzyMatches: results.filter(r => r.searchMethod === 'fuzzy').length
      }
    };

    console.log('✅ Processing complete');
    console.log('🎯 Search method breakdown:', response.debug);
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
