// buybackstep4.js - Real Shopify Integration
module.exports = async function handler(req, res) {
  console.log('=== SHOPIFY CARD SEARCH API START ===');
  console.log('Method:', req.method);
  console.log('Body:', req.body);

  try {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        message: 'Shopify Card Search API is running',
        timestamp: new Date().toISOString()
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST method required' });
    }

    const { cards, employeeName, payoutMethod } = req.body;
    
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Cards array is required'
      });
    }

    const cardName = cards[0]?.cardName;
    console.log('🔍 Searching Shopify for:', cardName);

    // Your Shopify credentials
    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

    // Search Shopify products
    const searchShopifyProducts = async (query) => {
      console.log('📦 Querying Shopify API for:', query);
      
      try {
        // Try direct title search first
        const titleSearchUrl = `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?` +
          `title=${encodeURIComponent(query)}&` +
          `limit=50&` +
          `fields=id,title,variants,product_type,tags,handle`;

        console.log('🔗 Shopify URL:', titleSearchUrl);

        const response = await fetch(titleSearchUrl, {
          headers: {
            'X-Shopify-Access-Token': ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.log('❌ Shopify API error:', response.status, errorText);
          throw new Error(`Shopify API failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log(`📦 Shopify returned ${data.products?.length || 0} products from title search`);

        let products = data.products || [];

        // If no results from title search, try broader search
        if (products.length === 0) {
          console.log('🔍 No title matches, trying broader search...');
          
          const broadSearchUrl = `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?` +
            `limit=250&` +
            `fields=id,title,variants,product_type,tags,handle`;

          const broadResponse = await fetch(broadSearchUrl, {
            headers: {
              'X-Shopify-Access-Token': ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          });

          if (broadResponse.ok) {
            const broadData = await broadResponse.json();
            
            // Filter products that match the search term
            products = broadData.products?.filter(product => {
              const titleMatch = product.title.toLowerCase().includes(query.toLowerCase());
              const skuMatch = product.variants.some(variant => 
                variant.sku && variant.sku.toLowerCase().includes(query.toLowerCase())
              );
              const handleMatch = product.handle.includes(query.toLowerCase().replace(/\s+/g, '-'));
              
              return titleMatch || skuMatch || handleMatch;
            }) || [];
            
            console.log(`📦 Broader search found ${products.length} matching products`);
          }
        }

        return products;

      } catch (error) {
        console.error('❌ Shopify search error:', error);
        throw error;
      }
    };

    // Find the best matching product
    const findBestMatch = (products, query) => {
      if (!products || products.length === 0) {
        console.log('❌ No products to match against');
        return null;
      }

      console.log('🎯 Finding best match for:', query);

      // 1. Try exact title match
      let bestMatch = products.find(p => 
        p.title.toLowerCase() === query.toLowerCase()
      );

      if (bestMatch) {
        console.log('✅ Exact title match:', bestMatch.title);
        return bestMatch;
      }

      // 2. Try partial title match
      bestMatch = products.find(p => 
        p.title.toLowerCase().includes(query.toLowerCase()) ||
        query.toLowerCase().includes(p.title.toLowerCase())
      );

      if (bestMatch) {
        console.log('✅ Partial title match:', bestMatch.title);
        return bestMatch;
      }

      // 3. Try SKU match (for card numbers like "001/182")
      if (query.includes('/') || query.includes('#')) {
        bestMatch = products.find(p => 
          p.variants.some(v => 
            v.sku && (
              v.sku.includes(query) || 
              query.includes(v.sku) ||
              v.sku.toLowerCase().includes(query.toLowerCase())
            )
          )
        );

        if (bestMatch) {
          console.log('✅ SKU match:', bestMatch.title);
          return bestMatch;
        }
      }

      // 4. Try handle match
      const queryHandle = query.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      bestMatch = products.find(p => 
        p.handle.includes(queryHandle) || queryHandle.includes(p.handle)
      );

      if (bestMatch) {
        console.log('✅ Handle match:', bestMatch.title);
        return bestMatch;
      }

      console.log('❌ No match found for:', query);
      return null;
    };

    // Calculate trade values based on payout method
    const calculateTradeValues = (retailPrice, payoutMethod) => {
      const baseTradeRate = 0.6; // 60% base
      const maxTradeRate = 0.75; // 75% max
      
      const baseTradeValue = retailPrice * baseTradeRate;
      const maxTradeValue = retailPrice * maxTradeRate;
      
      let suggestedTradeValue = baseTradeValue;
      
      // Apply payout bonuses
      switch (payoutMethod) {
        case 'store-credit':
          suggestedTradeValue = baseTradeValue * 1.25; // 25% bonus
          break;
        case 'gift-card':
          suggestedTradeValue = baseTradeValue * 1.10; // 10% bonus
          break;
        case 'cash':
        default:
          suggestedTradeValue = baseTradeValue; // No bonus
          break;
      }

      return {
        baseTradeValue: parseFloat(baseTradeValue.toFixed(2)),
        suggestedTradeValue: parseFloat(Math.min(suggestedTradeValue, maxTradeValue).toFixed(2)),
        maximumTradeValue: parseFloat(maxTradeValue.toFixed(2))
      };
    };

    // Execute the search
    const products = await searchShopifyProducts(cardName);
    const bestMatch = findBestMatch(products, cardName);

    let result;
    
    if (bestMatch && bestMatch.variants && bestMatch.variants.length > 0) {
      const variant = bestMatch.variants[0];
      const retailPrice = parseFloat(variant.price) || 0;
      const tradeValues = calculateTradeValues(retailPrice, payoutMethod);
      
      console.log('✅ FOUND MATCH:', {
        title: bestMatch.title,
        sku: variant.sku,
        price: retailPrice,
        suggestedTrade: tradeValues.suggestedTradeValue
      });
      
      result = {
        cardName: cardName,
        match: bestMatch.title,
        sku: variant.sku || `SHOPIFY-${variant.id}`,
        retailPrice: retailPrice,
        suggestedTradeValue: tradeValues.suggestedTradeValue,
        maximumTradeValue: tradeValues.maximumTradeValue,
        baseTradeValue: tradeValues.baseTradeValue,
        productId: bestMatch.id,
        variantId: variant.id,
        quantity: cards[0]?.quantity || 1,
        condition: 'NM',
        searchMethod: 'shopify_real'
      };
    } else {
      console.log('❌ NO MATCH FOUND in Shopify for:', cardName);
      result = {
        cardName: cardName,
        match: null,
        sku: null,
        retailPrice: 0,
        suggestedTradeValue: 0,
        maximumTradeValue: 0,
        baseTradeValue: 0,
        quantity: cards[0]?.quantity || 1,
        condition: 'NM',
        searchMethod: 'shopify_real'
      };
    }

    const response = {
      success: true,
      results: [result],
      searchInfo: {
        query: cardName,
        totalProducts: products.length,
        matchFound: !!bestMatch,
        employee: employeeName,
        payoutMethod: payoutMethod,
        searchMethod: 'shopify_api',
        timestamp: new Date().toISOString()
      },
      shopifyInfo: {
        domain: SHOPIFY_DOMAIN,
        productsSearched: products.length,
        apiCallsUsed: products.length > 0 ? (products.length === 1 ? 1 : 2) : 1
      }
    };

    console.log('📋 Sending Shopify search response');
    return res.status(200).json(response);

  } catch (error) {
    console.error('💥 SHOPIFY API ERROR:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Shopify search failed',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
