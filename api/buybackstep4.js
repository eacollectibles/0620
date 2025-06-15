module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const estimateMode = req.query?.estimate === 'true';
    const { cards, employeeName, payoutMethod, overrideTotal, customerEmail } = req.body;

    // Add customer email validation for store credit
    if (!estimateMode && payoutMethod === "store-credit" && !customerEmail) {
      return res.status(400).json({ error: 'Customer email is required for store credit payouts' });
    }

    if (!cards || !Array.isArray(cards)) {
      return res.status(400).json({ error: 'Invalid or missing cards array' });
    }

    // Validate override total if provided
    let validatedOverride = null;
    if (overrideTotal !== undefined && overrideTotal !== null && overrideTotal !== '') {
      const override = parseFloat(overrideTotal);
      if (isNaN(override)) {
        return res.status(400).json({ error: 'Override total must be a valid number' });
      }
      if (override < 0) {
        return res.status(400).json({ error: 'Override total cannot be negative' });
      }
      // Store credit limit is $10,000 USD ≈ $13,500 CAD
      if (override > 13500) {
        return res.status(400).json({ error: 'Override total exceeds maximum allowed limit ($13,500 CAD)' });
      }
      validatedOverride = override;
    }

    // Prevent overrides in estimate mode (optional business rule)
    if (estimateMode && validatedOverride !== null) {
      return res.status(400).json({ error: 'Override total not allowed in estimate mode' });
    }

    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

    // NEW: Store credit helper functions
    const findOrCreateCustomer = async (email) => {
      try {
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
        
        if (searchData.customers && searchData.customers.length > 0) {
          return searchData.customers[0];
        }

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
          throw new Error(`Failed to create customer: ${await createRes.text()}`);
        }

        const customerData = await createRes.json();
        return customerData.customer;
      } catch (err) {
        console.error('Error finding/creating customer:', err);
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

        const result = await graphqlRes.json();
        
        console.log('GraphQL Response:', JSON.stringify(result, null, 2));
        console.log('Store credit mutation result:', {
          hasData: !!result.data,
          hasStoreCreditCreate: !!result.data?.storeCreditAccountCreditCreate,
          hasTransaction: !!result.data?.storeCreditAccountCreditCreate?.storeCreditAccountTransaction,
          hasErrors: !!result.data?.storeCreditAccountCreditCreate?.userErrors?.length,
          errors: result.data?.storeCreditAccountCreditCreate?.userErrors,
          graphqlErrors: result.errors
        });
        
        if (result.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
        }
        
        if (result.data?.storeCreditAccountCreditCreate?.userErrors?.length > 0) {
          throw new Error(`Store credit error: ${result.data.storeCreditAccountCreditCreate.userErrors[0].message}`);
        }

        const transaction = result.data?.storeCreditAccountCreditCreate?.storeCreditAccountTransaction;
        
        if (!transaction) {
          throw new Error('Store credit transaction was not created - no transaction returned');
        }

        return transaction;
      } catch (err) {
        console.error('Error issuing store credit:', err);
        throw err;
      }
    };

    // NEW: Chronological tracking array
    const chronologicalLog = [];
    
    // Helper function to add chronological entry
    function addChronologicalEntry(cardName, inputSku, action, result = null, variantSku = null, productTitle = null, searchMethod = null) {
      chronologicalLog.push({
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
      });
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

    // Get location ID once for inventory updates
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
      } catch (err) {
        console.error('Failed to get location ID:', err);
      }
    }

    const fetchVariantBySKU = async (sku) => {
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
      return variantEdge?.node || null;
    };

    const fetchVariantByTag = async (tag) => {
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
        
        return {
          price: variant.price,
          inventory_item_id: variant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', ''),
          product: {
            title: product.title
          },
          sku: variant.sku
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

    for (const card of cards) {
      const { cardName, sku = null, quantity = 1 } = card;
      const cardStartTime = Date.now();
      
      // Log the start of processing this card
      addChronologicalEntry(cardName, sku, 'PROCESSING_START', 'Starting card lookup process');
      
      let variant = null;
      let productTitle = null;
      let productSku = null;
      let searchMethod = null; // Track which method found the product

      // METHOD 1: First try to find by product title
      addChronologicalEntry(cardName, sku, 'SEARCH_BY_TITLE', 'Attempting to find product by title');
      
      const productRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?title=${encodeURIComponent(cardName)}`,
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
        addChronologicalEntry(cardName, sku, 'ERROR', 'Failed to parse product data');
        return res.status(500).json({ error: 'Failed to parse product data', details: err.message });
      }

      // If found by product title
      if (productData && productData.products && productData.products.length > 0) {
        const match = productData.products[0];
        variant = match.variants[0];
        productTitle = match.title;
        productSku = variant.sku;
        searchMethod = 'title';
        
        addChronologicalEntry(
          cardName, 
          sku, 
          'FOUND_BY_TITLE', 
          'Product found by title search', 
          productSku, 
          productTitle, 
          searchMethod
        );
      } else {
        addChronologicalEntry(cardName, sku, 'TITLE_SEARCH_FAILED', 'No product found by title, trying SKU search');
        
        // METHOD 2: Try variant SKU match
        addChronologicalEntry(cardName, sku, 'SEARCH_BY_SKU', 'Attempting to find product by SKU');
        
        const matchedVariant = await fetchVariantBySKU(sku || cardName);
        if (matchedVariant) {
          variant = {
            price: matchedVariant.price,
            inventory_item_id: matchedVariant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
          };
          productTitle = matchedVariant.product.title;
          productSku = matchedVariant.sku;
          searchMethod = 'sku';
          
          addChronologicalEntry(
            cardName, 
            sku, 
            'FOUND_BY_SKU', 
            'Product found by SKU search', 
            productSku, 
            productTitle, 
            searchMethod
          );
        } else {
          addChronologicalEntry(cardName, sku, 'SKU_SEARCH_FAILED', 'No product found by SKU, trying tag search');
          
          // METHOD 3: Try tag search as third option
          addChronologicalEntry(cardName, sku, 'SEARCH_BY_TAG', 'Attempting to find product by tag');
          
          const tagVariant = await fetchVariantByTag(cardName);
          if (tagVariant) {
            variant = {
              price: tagVariant.price,
              inventory_item_id: tagVariant.inventory_item_id
            };
            productTitle = tagVariant.product.title;
            productSku = tagVariant.sku;
            searchMethod = 'tag';
            
            addChronologicalEntry(
              cardName, 
              sku, 
              'FOUND_BY_TAG', 
              'Product found by tag search', 
              productSku, 
              productTitle, 
              searchMethod
            );
          } else {
            // No match found by any method
            addChronologicalEntry(
              cardName, 
              sku, 
              'NO_MATCH_FOUND', 
              'No product found by any search method', 
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
        }
      }

      if (!variant) {
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

      // Update inventory if not in estimate mode
      if (!estimateMode && locationId && variant.inventory_item_id) {
        try {
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
            console.log(`Inventory updated for ${cardName}: +${quantity}, new total: ${adjustData.inventory_level?.available || 'unknown'}`);
            
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
            console.error(`Failed to update inventory for ${cardName}:`, await adjustRes.text());
            
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
          console.error(`Failed to update inventory for ${cardName}:`, inventoryErr);
          
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

    // Log override usage for auditing
    if (overrideUsed && !estimateMode) {
      console.log(`OVERRIDE USED: Employee: ${employeeName || 'Unknown'}, Suggested: $${totalSuggestedValue.toFixed(2)}, Override: $${finalPayout.toFixed(2)}, Difference: $${(finalPayout - totalSuggestedValue).toFixed(2)}`);
    }

    // Log search method statistics for debugging
    if (!estimateMode) {
      const searchStats = results.reduce((acc, result) => {
        acc[result.searchMethod] = (acc[result.searchMethod] || 0) + 1;
        return acc;
      }, {});
      console.log(`Search method statistics:`, searchStats);
    }

    // NEW: Handle store credit, gift card, or cash payouts
    let giftCardCode = null;
    let storeCreditTransaction = null;
    let customer = null;

    if (!estimateMode && finalPayout > 0) {
      if (payoutMethod === "store-credit") {
        try {
          // Find or create customer
          customer = await findOrCreateCustomer(customerEmail);
          console.log('Customer found/created:', {
            id: customer.id,
            email: customer.email,
            gid: `gid://shopify/Customer/${customer.id}`
          });
          
          // Issue store credit using new native feature
          const reason = `Trade-in payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override: $${finalPayout.toFixed(2)}, Suggested: $${totalSuggestedValue.toFixed(2)})` : ''}`;
          
          console.log('Attempting store credit with:', {
            customerId: customer.id,
            amount: finalPayout,
            reason: reason
          });
          
          storeCreditTransaction = await issueStoreCredit(customer.id, finalPayout, reason);
          
          console.log(`Store credit issued: $${finalPayout.toFixed(2)} CAD to ${customerEmail}`);
          
        } catch (err) {
          console.error("Store credit creation failed:", err);
          console.error("Store credit error details:", {
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
          const giftCardRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/gift_cards.json`, {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": ACCESS_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              gift_card: {
                initial_value: finalPayout.toFixed(2),
                note: `Trade-in payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override: $${finalPayout.toFixed(2)}, Suggested: $${totalSuggestedValue.toFixed(2)})` : ''}`,
                currency: "CAD"
              }
            })
          });
          
          if (!giftCardRes.ok) {
            const errorText = await giftCardRes.text();
            console.error("Gift card creation failed:", errorText);
            return res.status(500).json({ 
              error: "Gift card creation failed", 
              details: errorText 
            });
          }
          
          const giftCardData = await giftCardRes.json();
          giftCardCode = giftCardData?.gift_card?.code || null;
          
          console.log(`Gift card created: $${finalPayout.toFixed(2)} CAD, Code: ${giftCardCode}`);
          
        } catch (giftCardErr) {
          console.error("Gift card creation failed:", giftCardErr);
          return res.status(500).json({ 
            error: "Gift card creation failed", 
            details: giftCardErr.message 
          });
        }
      } else if (payoutMethod === "cash") {
        // For cash payouts, no gift card or store credit needed
        console.log(`Cash payout: $${finalPayout.toFixed(2)} CAD for ${employeeName || "Unknown"}`);
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

    // Return comprehensive response with chronological data
    res.status(200).json({
      success: true,
      
      // Payment method details
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
      
      // Transaction details
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
      overrideDifference: overrideUsed ? (finalPayout - totalSuggestedValue).toFixed(2) : null,
      timestamp: new Date().toISOString(),
      
      // NEW: Chronological tracking data
      chronologicalLog: chronologicalLog,
      chronologicalCardsSummary: chronologicalCardsSummary,
      processingStats: {
        totalCards: cards.length,
        cardsFound: chronologicalCardsSummary.length,
        cardsNotFound: cards.length - chronologicalCardsSummary.length,
        totalProcessingTime: Date.now() - processingStartTime,
        searchMethodBreakdown: results.reduce((acc, result) => {
          acc[result.searchMethod] = (acc[result.searchMethod] || 0) + 1;
          return acc;
        }, {})
      }
    });

  } catch (err) {
    console.error("Fatal API Error:", err);
    return res.status(500).json({ 
      error: "Internal server error", 
      details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
    });
  }
};
