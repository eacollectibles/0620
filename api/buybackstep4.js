
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
    const results = [];

    for (const card of cards) {
      const { cardName, sku = null, quantity = 1 } = card;

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
        const variantsRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/variants.json`, {
          method: 'GET',
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        });

        const variantsText = await variantsRes.text();
        let variantsData;
        try {
          variantsData = JSON.parse(variantsText);
        } catch (parseErr) {
          return res.status(500).json({ error: 'Failed to parse variants data', details: parseErr.message });
        }

        const matchedVariant = await fetchVariantBySKU(sku || cardName);
        if (matchedVariant) {
          const variantPrice = parseFloat(matchedVariant.price || 0);
          const tradeInValue = parseFloat((variantPrice * 0.3).toFixed(2));
          totalValue += tradeInValue * quantity;
          results.push({
            cardName: matchedVariant.title,
            match: matchedVariant.title,
            tradeInValue,
            quantity
          });
          continue;
        } else {
          results.push({
            cardName,
            match: null,
            tradeInValue: 0,
            quantity
          });
          continue;
        }
      }

      // Fallback to first product variant
      const match = productData.products[0];
      const variant = match.variants[0];
      const variantPrice = parseFloat(variant.price || 0);
      const tradeInValue = parseFloat((variantPrice * 0.3).toFixed(2));
      totalValue += tradeInValue * quantity;

      results.push({
        cardName,
        match: match.title,
        tradeInValue,
        quantity
      });
    }

    const finalPayout = overrideTotal !== undefined ? parseFloat(overrideTotal) : totalValue;

    
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
      overrideTotal: overrideTotal ? finalPayout.toFixed(2) : null
    });
  } catch (err) {
    console.error("Fatal API Error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
};
