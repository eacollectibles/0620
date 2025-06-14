
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

    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

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

    let totalValue = 0;
    let totalRetailValue = 0;
    const results = [];

    for (const card of cards) {
      const { cardName, sku = null, quantity = 1 } = card;
      let variant = null;
      let productTitle = null;
      let productSku = null; // Store the actual SKU

      // First try to find by product title
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

      // If no product by title, try variant SKU match
      if (!productData || !productData.products || productData.products.length === 0) {
        const matchedVariant = await fetchVariantBySKU(sku || cardName);
        if (matchedVariant) {
          variant = {
            price: matchedVariant.price,
            inventory_item_id: matchedVariant.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
          };
          productTitle = matchedVariant.product.title;
          productSku = matchedVariant.sku; // Get the actual SKU
        } else {
          results.push({
            cardName,
            match: null,
            retailPrice: 0,
            tradeInValue: 0,
            quantity,
            sku: null // No SKU if no match
          });
          continue;
        }
      } else {
        // Use first product variant
        const match = productData.products[0];
        variant = match.variants[0];
        productTitle = match.title;
        productSku = variant.sku; // Get the actual SKU from variant
      }

      if (!variant) {
        results.push({
          cardName,
          match: null,
          retailPrice: 0,
          tradeInValue: 0,
          quantity,
          sku: null
        });
        continue;
      }

      const variantPrice = parseFloat(variant.price || 0);
      const tradeInValue = parseFloat((variantPrice * 0.3).toFixed(2));
      totalValue += tradeInValue * quantity;
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
        tradeInValue,
        quantity,
        sku: productSku // Include the actual SKU in the response
      });
    }

    const finalPayout = overrideTotal !== undefined ? parseFloat(overrideTotal) : totalValue;

    // Create gift card if needed
    let giftCardCode = null;
    if (payoutMethod === "store-credit" && finalPayout > 0) {
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
              note: `Buyback payout for ${employeeName || "Unknown"}`,
              currency: "CAD"
            }
          })
        });
        const giftCardData = await giftCardRes.json();
        giftCardCode = giftCardData?.gift_card?.code || null;
      } catch (err) {
        console.error("Gift card creation failed:", err);
      }
    }

    res.status(200).json({
      giftCardCode,
      estimate: estimateMode,
      employeeName,
      payoutMethod,
      results,
      total: totalValue.toFixed(2),
      totalRetailValue: totalRetailValue.toFixed(2),
      overrideTotal: overrideTotal ? finalPayout.toFixed(2) : null
    });
  } catch (err) {
    console.error("Fatal API Error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
};
