// buybackstep4.js - DIAGNOSTIC VERSION to see what's in your Shopify
module.exports = async function handler(req, res) {
  console.log('=== SHOPIFY DIAGNOSTIC API START ===');
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
        message: 'Shopify Diagnostic API is running',
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
    console.log('🔍 DIAGNOSTIC SEARCH for:', cardName);

    // Your Shopify credentials
    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

    // DIAGNOSTIC: Get first 10 products to see structure
    const diagnosticUrl = `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?` +
      `limit=10&` +
      `fields=id,title,variants,product_type,tags,handle`;

    console.log('🔗 DIAGNOSTIC URL:', diagnosticUrl);

    const diagnosticResponse = await fetch(diagnosticUrl, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (!diagnosticResponse.ok) {
      const errorText = await diagnosticResponse.text();
      console.log('❌ Shopify API error:', diagnosticResponse.status, errorText);
      throw new Error(`Shopify API failed: ${diagnosticResponse.status}`);
    }

    const diagnosticData = await diagnosticResponse.json();
    console.log('📊 DIAGNOSTIC: Found', diagnosticData.products?.length || 0, 'products');

    // Log detailed info about first few products
    const products = diagnosticData.products || [];
    const diagnosticInfo = [];

    products.slice(0, 5).forEach((product, index) => {
      console.log(`\n🔍 PRODUCT ${index + 1}:`);
      console.log(`  Title: "${product.title}"`);
      console.log(`  Handle: "${product.handle}"`);
      console.log(`  Tags: "${product.tags}"`);
      console.log(`  Product Type: "${product.product_type}"`);
      console.log(`  Variants (${product.variants?.length || 0}):`);
      
      const variantInfo = [];
      product.variants?.forEach((variant, vIndex) => {
        console.log(`    Variant ${vIndex + 1}:`);
        console.log(`      SKU: "${variant.sku || 'NO SKU'}"`);
        console.log(`      Price: $${variant.price || 'NO PRICE'}"`);
        console.log(`      Title: "${variant.title || 'NO TITLE'}"`);
        
        variantInfo.push({
          sku: variant.sku,
          price: variant.price,
          title: variant.title
        });
      });

      diagnosticInfo.push({
        title: product.title,
        handle: product.handle,
        tags: product.tags,
        productType: product.product_type,
        variants: variantInfo
      });
    });

    // Now try to find your specific search
    console.log(`\n🎯 SEARCHING FOR: "${cardName}"`);
    
    let foundProducts = [];
    
    // Search all products for the query
    const allProductsUrl = `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?` +
      `limit=250&` +
      `fields=id,title,variants,product_type,tags,handle`;

    const allResponse = await fetch(allProductsUrl, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (allResponse.ok) {
      const allData = await allResponse.json();
      const allProducts = allData.products || [];
      
      console.log(`📦 Searching through ${allProducts.length} total products`);
      
      // Test different search strategies
      const searchStrategies = [
        { name: 'Exact Title', test: (p) => p.title.toLowerCase() === cardName.toLowerCase() },
        { name: 'Title Contains', test: (p) => p.title.toLowerCase().includes(cardName.toLowerCase()) },
        { name: 'SKU Exact', test: (p) => p.variants.some(v => v.sku === cardName) },
        { name: 'SKU Contains', test: (p) => p.variants.some(v => v.sku && v.sku.toLowerCase().includes(cardName.toLowerCase())) },
        { name: 'Tags Contains', test: (p) => p.tags && p.tags.toLowerCase().includes(cardName.toLowerCase()) },
        { name: 'Handle Contains', test: (p) => p.handle.includes(cardName.toLowerCase().replace(/\s+/g, '-')) }
      ];

      searchStrategies.forEach(strategy => {
        const matches = allProducts.filter(strategy.test);
        console.log(`🔍 ${strategy.name}: ${matches.length} matches`);
        
        if (matches.length > 0) {
          matches.slice(0, 3).forEach(match => {
            console.log(`  ✅ "${match.title}"`);
            match.variants?.forEach(v => {
              if (v.sku) console.log(`    SKU: "${v.sku}"`);
            });
          });
          foundProducts = foundProducts.concat(matches);
        }
      });
    }

    // Remove duplicates
    foundProducts = foundProducts.filter((product, index, self) => 
      index === self.findIndex(p => p.id === product.id)
    );

    const response = {
      success: true,
      diagnostic: {
        searchQuery: cardName,
        totalProductsInStore: products.length > 0 ? 'At least ' + products.length : 'Unknown',
        sampleProducts: diagnosticInfo,
        searchResults: foundProducts.length,
        foundProducts: foundProducts.slice(0, 3).map(p => ({
          title: p.title,
          handle: p.handle,
          tags: p.tags,
          variants: p.variants?.map(v => ({ sku: v.sku, price: v.price }))
        }))
      },
      results: foundProducts.length > 0 ? [{
        cardName: cardName,
        match: foundProducts[0].title,
        sku: foundProducts[0].variants?.[0]?.sku || null,
        retailPrice: parseFloat(foundProducts[0].variants?.[0]?.price) || 0,
        suggestedTradeValue: 0,
        maximumTradeValue: 0,
        searchMethod: 'diagnostic'
      }] : [{
        cardName: cardName,
        match: null,
        sku: null,
        retailPrice: 0,
        suggestedTradeValue: 0,
        maximumTradeValue: 0,
        searchMethod: 'diagnostic'
      }],
      timestamp: new Date().toISOString()
    };

    console.log('📋 DIAGNOSTIC COMPLETE');
    return res.status(200).json(response);

  } catch (error) {
    console.error('💥 DIAGNOSTIC ERROR:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Diagnostic failed',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
