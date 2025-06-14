
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { cardName, quantity = 1 } = req.body;
  if (!cardName) {
    return res.status(400).json({ error: 'Missing card name' });
  }

  const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
  const ACCESS_TOKEN = "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";

  try {
    // Step 1: Find the product
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

    if (!productData.products || productData.products.length === 0) {
      return res.status(404).json({ error: 'Card not found in Shopify inventory' });
    }

    const product = productData.products[0];
    const variant = product.variants[0];
    const inventoryItemId = variant.inventory_item_id;

    // Step 2: Get location ID
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

    // Step 3: Adjust inventory level
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

    // Return product info and confirmation
    return res.status(200).json({
      name: product.title,
      sku: variant.sku,
      price: parseFloat(variant.price),
      inventory: adjustData.inventory_level.available,
      condition: "NM",
      tradeInValue: (parseFloat(variant.price) * 0.30).toFixed(2),
      restocked: parseInt(quantity)
    });

  } catch (err) {
    console.error('Shopify API Error:', err);
    return res.status(500).json({ error: 'Failed to connect to Shopify API', details: err.message });
  }
};
