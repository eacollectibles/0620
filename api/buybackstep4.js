
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { cardName, cardSku, quantity = 1 } = req.body;
  if (!cardName) {
    return res.status(400).json({ error: 'Missing card name' });
  }

  const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || "ke40sv-my.myshopify.com";
  const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || "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";

  try {
    let product = null;
    let variant = null;

    // Step 1: Try to find product by title (ORIGINAL WORKING METHOD)
    const productRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?title=${encodeURIComponent(cardName)}`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    const productText = await productRes.text();

    let productData;
    try {
      productData = JSON.parse(productText);
    } catch (parseErr) {
      return res.status(500).json({ error: "Invalid JSON from Shopify", raw: productText });
    }

    // Step 2: If found by title, use it
    if (productData.products && productData.products.length > 0) {
      product = productData.products[0];
      variant = product.variants[0];
    }
    // Step 3: If not found by title and we have a SKU, try SKU lookup
    else if (cardSku) {
      const skuRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/variants.json?sku=${encodeURIComponent(cardSku)}`, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      
      const skuText = await skuRes.text();
      let skuData;
      try {
        skuData = JSON.parse(skuText);
      } catch (parseErr) {
        return res.status(500).json({ error: "Invalid JSON from SKU lookup", raw: skuText });
      }

      if (skuData.variants && skuData.variants.length > 0) {
        variant = skuData.variants[0];
        
        // Get the full product info for this variant
        const productByIdRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products/${variant.product_id}.json`, {
          method: 'GET',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        
        const productByIdData = await productByIdRes.json();
        product = productByIdData.product;
      }
    }

    // Step 4: If still no product found, return error
    if (!product || !variant) {
      return res.status(404).json({ error: 'Card not found in Shopify inventory by title or SKU' });
    }

    const inventoryItemId = variant.inventory_item_id;

    // Step 5: Get location ID (ORIGINAL WORKING METHOD)
    const locationRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/locations.json`, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const locations = await locationRes.json();
    if (!locations.locations || locations.locations.length === 0) {
      return res.status(500).json({ error: 'No inventory locations found' });
    }

    const locationId = locations.locations[0].id;

    // Step 6: Adjust inventory level (ORIGINAL WORKING METHOD)
    const adjustRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/inventory_levels/adjust.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available_adjustment: parseInt(quantity)
      })
    });

    const adjustData = await adjustRes.json();
    if (adjustRes.status !== 200) {
      return res.status(500).json({ error: "Failed to adjust inventory", details: adjustData });
    }

    // Step 7: Return product info and confirmation (ORIGINAL WORKING RESPONSE)
    return res.status(200).json({
      name: product.title,
      sku: variant.sku || cardSku,
      price: parseFloat(variant.price),
      inventory: adjustData.inventory_level.available,
      condition: "NM",
      tradeInValue: (parseFloat(variant.price) * 0.30).toFixed(2),
      restocked: parseInt(quantity),
      foundBy: variant.sku === cardSku ? 'SKU' : 'Title' // Optional: shows how it was found
    });

  } catch (err) {
    console.error('Shopify API Error:', err);
    return res.status(500).json({ error: 'Failed to connect to Shopify API', details: err.message });
  }
};
