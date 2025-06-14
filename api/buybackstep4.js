module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const estimateMode = req.query?.estimate === 'true';
    const { cards, employeeName, payoutMethod, overrideTotal } = req.body;

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
      // Optional: Add maximum override limit (e.g., $10,000)
      if (override > 10000) {
        return res.status(400).json({ error: 'Override total exceeds maximum allowed limit ($10,000)' });
      }
      validatedOverride = override;
    }

    // Prevent overrides in estimate mode (optional business rule)
    if (estimateMode && validatedOverride !== null) {
      return res.status(400).json({ error: 'Override total not allowed in estimate mode' });
    }

    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

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

    for (const card of cards) {
      const { cardName, sku = null, quantity = 1 } = card;
      let variant = null;
      let productTitle = null;
      let productSku = null;
      let searchMethod = null; // Track which method found the product

      // METHOD 1: First try to find by product title
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
        return res.status(500).json({ error: 'Failed to parse product data', details: err.message });
      }

      // If found by product title
      if (productData && productData.products && productData.products.length > 0) {
        const match = productData.products[0];
        variant = match.variants[0];
        productTitle = match.title;
        productSku = variant.sku;
        searchMethod = 'title';
      } else {
        // METHOD 2: Try variant SKU match
        const matchedVariant = await fetchVariantBySKU(sku || cardName);
        if (matchedVariant) {
          variant = {
            price: matchedVariant.price,
            inventory_item_id: matchedVariant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
          };
          productTitle = matchedVariant.product.title;
          productSku = matchedVariant.sku;
          searchMethod = 'sku';
        } else {
          // METHOD 3: Try tag search as third option
          const tagVariant = await fetchVariantByTag(cardName);
          if (tagVariant) {
            variant = {
              price: tagVariant.price,
              inventory_item_id: tagVariant.inventory_item_id
            };
            productTitle = tagVariant.product.title;
            productSku = tagVariant.sku;
            searchMethod = 'tag';
          } else {
            // No match found by any method
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
          } else {
            console.error(`Failed to update inventory for ${cardName}:`, await adjustRes.text());
          }
        } catch (inventoryErr) {
          console.error(`Failed to update inventory for ${cardName}:`, inventoryErr);
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

    // Create gift card if needed (only for actual transactions, not estimates)
    let giftCardCode = null;
    if (!estimateMode && payoutMethod === "store-credit" && finalPayout > 0) {
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
              note: `Buyback payout for ${employeeName || "Unknown"}${overrideUsed ? ` (Override: $${finalPayout.toFixed(2)}, Suggested: $${totalSuggestedValue.toFixed(2)})` : ''}`,
              currency: "CAD"
            }
          })
        });
        
        if (!giftCardRes.ok) {
          const errorText = await giftCardRes.text();
          console.error("Gift card creation failed:", errorText);
          return res.status(500).json({ error: "Failed to create gift card", details: errorText });
        }
        
        const giftCardData = await giftCardRes.json();
        giftCardCode = giftCardData?.gift_card?.code || null;
        
        if (!giftCardCode) {
          console.error("Gift card created but no code returned:", giftCardData);
          return res.status(500).json({ error: "Gift card created but code not available" });
        }
      } catch (err) {
        console.error("Gift card creation failed:", err);
        return res.status(500).json({ error: "Failed to create gift card", details: err.message });
      }
    }

    // Return comprehensive response
    res.status(200).json({
      success: true,
      giftCardCode,
      estimate: estimateMode,
      employeeName,
      payoutMethod,
      results,
      suggestedTotal: totalSuggestedValue.toFixed(2),
      maximumTotal: totalMaximumValue.toFixed(2),
      totalRetailValue: totalRetailValue.toFixed(2),
      finalPayout: finalPayout.toFixed(2),
      overrideUsed,
      overrideAmount: overrideUsed ? finalPayout.toFixed(2) : null,
      overrideDifference: overrideUsed ? (finalPayout - totalSuggestedValue).toFixed(2) : null,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("Fatal API Error:", err);
    return res.status(500).json({ 
      error: "Internal server error", 
      details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
    });
  }
};
