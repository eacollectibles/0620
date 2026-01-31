// api/customer-submissions.js
// This handles customer trade-in submissions with LIVE pricing data

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS request received - sending CORS headers');
    return res.status(200).end();
  }

  console.log('=== CUSTOMER SUBMISSION API ===');
  console.log('Method:', req.method);
  console.log('Body:', req.body);

  try {
    if (req.method === 'POST') {
      return await handleSubmission(req, res);
    } else if (req.method === 'GET') {
      return await handleGetSubmissions(req, res);
    } else {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
  } catch (err) {
    console.error("💥 CUSTOMER SUBMISSION ERROR:", err);
    return res.status(500).json({ 
      error: "Internal server error", 
      details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  }
};

async function handleSubmission(req, res) {
  const { 
    customerName, 
    customerEmail, 
    customerPhone, 
    payoutMethod, 
    cards
  } = req.body;

  // Validation - only require payoutMethod and cards
  if (!payoutMethod || !cards || !Array.isArray(cards)) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['payoutMethod', 'cards']
    });
  }

  if (cards.length === 0) {
    return res.status(400).json({ error: 'At least one card is required' });
  }

  // Check if this is an anonymous submission (no customer info)
  const isAnonymous = !customerEmail || customerEmail.trim() === '';
  
  // Email validation only if email is provided
  if (customerEmail && customerEmail.trim() !== '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
  }

  // Generate unique submission ID
  const submissionId = generateSubmissionId();
  
  console.log('📝 Processing customer submission:', submissionId);
  console.log('🃏 Cards to process:', cards.length);
  console.log('👤 Anonymous submission:', isAnonymous);

  try {
    // Process cards through main trade-in system to get LIVE pricing
    console.log('🔄 Getting live pricing estimates from trade-in system...');
    console.log('📋 Cards to estimate:', JSON.stringify(cards, null, 2));
    
    const estimateData = await getEstimateFromTradeInSystem({
      cards: cards,
      customerEmail: customerEmail || 'anonymous@tradein.local',
      payoutMethod: payoutMethod
    });

    console.log('✅ Live estimate received:', JSON.stringify({
      suggestedTotal: estimateData.suggestedTotal,
      cardsFound: estimateData.results.filter(r => r.match).length,
      cardsNotFound: estimateData.results.filter(r => !r.match).length,
      fullResults: estimateData.results
    }, null, 2));

    // Create submission object with LIVE data
    const submission = {
      id: submissionId,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      isAnonymous: isAnonymous,
      customer: {
        name: customerName || 'Walk-in Customer',
        email: customerEmail || null,
        phone: customerPhone || null
      },
      payoutMethod,
      cards: cards.map((card, index) => {
        const result = estimateData.results[index];
        return {
          cardName: card.cardName,
          quantity: parseInt(card.quantity) || 1,
          condition: card.condition || 'NM',
          sku: result?.sku || card.sku || null,
          searchMethod: card.searchMethod || 'manual',
          matchFound: !!result?.match,
          matchedProduct: result?.match || null,
          retailPrice: result?.retailPrice || 0,
          suggestedTradeValue: result?.suggestedTradeValue || 0,
          maximumTradeValue: result?.maximumTradeValue || 0,
          confidence: result?.confidence || null
        };
      }),
      estimateData: {
        suggestedTotal: parseFloat(estimateData.suggestedTotal),
        maximumTotal: parseFloat(estimateData.maximumTotal),
        totalRetailValue: parseFloat(estimateData.totalRetailValue),
        cardsFound: estimateData.processingStats.cardsFound,
        cardsNotFound: estimateData.processingStats.cardsNotFound,
        timestamp: estimateData.timestamp
      },
      estimatedValue: parseFloat(estimateData.suggestedTotal),
      notes: [],
      processedBy: null,
      processedAt: null
    };

    console.log('📦 Storing submission...');

    // Store submission - handle anonymous vs registered differently
    if (!isAnonymous) {
      // Full storage with Shopify customer
      await storeSubmission(submission);
      
      // Send confirmation email to customer
      await sendCustomerConfirmationEmail(submission);
    } else {
      // Store as anonymous submission (shop-level metafield only)
      await storeAnonymousSubmission(submission);
    }
    
    // Send notification to admin/staff
    await sendAdminNotificationEmail(submission);
    
    console.log('✅ Submission processed successfully:', submissionId);
    
    return res.status(201).json({
      success: true,
      submissionId: submissionId,
      status: 'pending',
      message: isAnonymous 
        ? 'Your trade-in quote has been generated!' 
        : 'Your trade-in request has been submitted successfully!',
      estimate: {
        suggestedTotal: submission.estimatedValue.toFixed(2),
        maximumTotal: parseFloat(estimateData.maximumTotal).toFixed(2),
        totalRetailValue: parseFloat(estimateData.totalRetailValue).toFixed(2),
        cardsProcessed: cards.length,
        cardsFound: estimateData.processingStats.cardsFound,
        cardsNotFound: estimateData.processingStats.cardsNotFound
      },
      estimatedProcessingTime: '24 hours',
      nextSteps: isAnonymous 
        ? [
            'Bring your cards to the store',
            'Show this confirmation number to staff',
            'Get your payout on the spot!'
          ]
        : [
            'You will receive a confirmation email shortly',
            'Our team will review your cards and confirm the final payout',
            'We will contact you within 24 hours with next steps'
          ],
      cardResults: submission.cards.map(card => ({
        cardName: card.cardName,
        quantity: card.quantity,
        matchFound: card.matchFound,
        matchedProduct: card.matchedProduct,
        estimatedValue: (card.suggestedTradeValue * card.quantity).toFixed(2)
      }))
    });

  } catch (error) {
    console.error('❌ Failed to process submission:', error);
    console.error('❌ Error stack:', error.stack);
    return res.status(500).json({
      error: 'Failed to process submission',
      details: 'Please try again or contact support',
      technicalDetails: error.message,
      errorStack: error.stack,
      errorName: error.name
    });
  }
}

// Function to get live estimates from your main trade-in system
async function getEstimateFromTradeInSystem(data) {
  console.log('🔄 Calling main trade-in API for estimate...');
  console.log('📊 Environment check:', {
    SHOPIFY_DOMAIN: process.env.SHOPIFY_DOMAIN ? '✅' : '❌',
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN ? '✅' : '❌'
  });
  
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!SHOPIFY_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    console.error('❌ Missing Shopify credentials in getEstimateFromTradeInSystem');
    throw new Error('Missing required Shopify credentials');
  }

  console.log('✅ Credentials validated, starting card processing...');
  console.log('📦 Processing', data.cards.length, 'cards');

  const makeShopifyRequest = async (endpoint, options = {}) => {
    const defaultHeaders = {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    };

    return fetch(`https://${SHOPIFY_DOMAIN}${endpoint}`, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers
      }
    });
  };

  const makeShopifyGraphQLRequest = async (query, variables = {}) => {
    return makeShopifyRequest('/admin/api/2023-10/graphql.json', {
      method: 'POST',
      body: JSON.stringify({ 
        query,
        variables
      })
    });
  };

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

  // Search functions
  function normalizeSearchTerm(term) {
    if (!term) return '';
    const normalized = term.replace(/[\/\-\s]/g, '');
    return normalized;
  }

  // Normalize One Piece / Pokemon set+number patterns
  // "EB03-026" -> "EB03026", "OP09 001" -> "OP09001"
  function normalizeCardNumber(cardName) {
    if (!cardName) return cardName;
    
    // One Piece patterns: OP09-001, EB03-026, ST01-001, PRB-001
    const onePiecePattern = /^(OP|EB|ST|PRB)\s*(\d{1,2})[\s\-]*(\d{1,3})$/i;
    const match = cardName.match(onePiecePattern);
    
    if (match) {
      const prefix = match[1].toUpperCase();
      const setNum = match[2].padStart(2, '0');
      const cardNum = match[3].padStart(3, '0');
      return `${prefix}${setNum}${cardNum}`;
    }
    
    // Pokemon patterns: SV07-025, SV07 025
    const pokemonPattern = /^(SV|SM|XY|BW|SWSH)\s*(\d{1,2})[\s\-]*(\d{1,3})$/i;
    const pkMatch = cardName.match(pokemonPattern);
    
    if (pkMatch) {
      const prefix = pkMatch[1].toUpperCase();
      const setNum = pkMatch[2].padStart(2, '0');
      const cardNum = pkMatch[3].padStart(3, '0');
      return `${prefix}${setNum}${cardNum}`;
    }
    
    return cardName;
  }

  function extractPotentialTags(cardName) {
    if (!cardName) return [];
    
    const tags = [];
    
    // First, check if it's a One Piece or Pokemon set pattern and normalize it
    const normalizedCardNum = normalizeCardNumber(cardName);
    if (normalizedCardNum !== cardName) {
      tags.push(normalizedCardNum);
    }
    
    // One Piece patterns in longer strings: "Luffy OP09-001" or "EB03-026 Super Rare"
    const onePieceInString = cardName.match(/(OP|EB|ST|PRB)\s*(\d{1,2})[\s\-]*(\d{1,3})/gi);
    if (onePieceInString) {
      onePieceInString.forEach(match => {
        const normalized = normalizeCardNumber(match.trim());
        if (normalized) tags.push(normalized);
      });
    }
    
    // Pokemon patterns in longer strings
    const pokemonInString = cardName.match(/(SV|SM|XY|BW|SWSH)\s*(\d{1,2})[\s\-]*(\d{1,3})/gi);
    if (pokemonInString) {
      pokemonInString.forEach(match => {
        const normalized = normalizeCardNumber(match.trim());
        if (normalized) tags.push(normalized);
      });
    }
    
    // Original number patterns like 025/198
    const numberPattern = /(\d+)[\/\-](\d+)/g;
    let match;
    
    while ((match = numberPattern.exec(cardName)) !== null) {
      tags.push(match[0]);
      tags.push(match[1] + match[2]);
    }
    
    // Standalone numbers (3-6 digits)
    const standaloneNumbers = cardName.match(/\b\d{3,6}\b/g);
    if (standaloneNumbers) {
      tags.push(...standaloneNumbers);
    }
    
    // Add the fully normalized search term
    tags.push(normalizeSearchTerm(cardName));
    
    return [...new Set(tags)];
  }

  const searchByTagWithAllOptions = async (tag, originalCardName) => {
    const normalizedTag = normalizeSearchTerm(tag);
    
    const query = `{
      products(first: 20, query: "tag:${normalizedTag}") {
        edges {
          node {
            id
            title
            tags
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }`;

    const graphqlRes = await makeShopifyGraphQLRequest(query);
    const json = await graphqlRes.json();
    
    const products = json?.data?.products?.edges || [];
    
    if (products.length === 0) {
      return { found: false };
    }

    const product = products[0].node;
    const variant = product.variants.edges[0]?.node;
    
    if (variant) {
      return {
        found: true,
        product: { title: product.title },
        variant: {
          sku: variant.sku,
          price: variant.price
        },
        searchMethod: 'tag'
      };
    }
    
    return { found: false };
  };

  const searchByTitle = async (query) => {
    const productRes = await makeShopifyRequest(
      `/admin/api/2023-10/products.json?title=${encodeURIComponent(query)}`
    );

    const productData = await productRes.json();
    
    if (productData?.products?.length > 0) {
      const product = productData.products[0];
      const variant = product.variants[0];
      
      return {
        found: true,
        product: product,
        variant: {
          sku: variant.sku,
          price: variant.price
        },
        searchMethod: 'title'
      };
    }
    
    return { found: false };
  };

  const searchCard = async (card) => {
    const { cardName, sku } = card;
    
    console.log(`  🔍 searchCard called for: "${cardName}"`);
    
    const potentialTags = extractPotentialTags(cardName);
    console.log(`  🏷️ Extracted tags:`, potentialTags);
    
    for (const tag of potentialTags) {
      if (!tag || tag.length < 2) continue;
      
      console.log(`    🔎 Trying tag search with: "${tag}"`);
      
      try {
        const result = await searchByTagWithAllOptions(tag, cardName);
        if (result.found) {
          console.log(`    ✅ Found via tag "${tag}"`);
          return result;
        } else {
          console.log(`    ❌ Tag "${tag}" - no results`);
        }
      } catch (error) {
        console.log(`    ❌ Tag search error for "${tag}":`, error.message);
        continue;
      }
    }
    
    console.log(`  🔎 Trying title search for: "${cardName}"`);
    try {
      const result = await searchByTitle(cardName);
      if (result.found) {
        console.log(`    ✅ Found via title search`);
        return result;
      } else {
        console.log(`    ❌ Title search - no results`);
      }
    } catch (error) {
      console.log(`    ❌ Title search error:`, error.message);
    }
    
    console.log(`  ❌ All search methods exhausted for: "${cardName}"`);
    return { found: false };
  };

  // Process all cards
  let totalSuggestedValue = 0;
  let totalMaximumValue = 0;
  let totalRetailValue = 0;
  const results = [];

  console.log('🔍 Starting card search loop...');

  for (const card of data.cards) {
    const { cardName, quantity = 1, condition = 'NM' } = card;
    
    console.log(`\n🃏 Processing card: "${cardName}" (qty: ${quantity})`);
    
    const searchResult = await searchCard(card);
    
    console.log(`🔍 Search result for "${cardName}":`, {
      found: searchResult.found,
      method: searchResult.searchMethod,
      product: searchResult.product?.title,
      price: searchResult.variant?.price
    });
    
    if (!searchResult.found) {
      console.log(`❌ No match found for: ${cardName}`);
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
    
    console.log(`✅ Match found: ${product.title} - ${variantPrice} (Trade: ${suggestedTradeValue})`);
    
    totalSuggestedValue += suggestedTradeValue * quantity;
    totalMaximumValue += maximumTradeValue * quantity;
    totalRetailValue += variantPrice * quantity;

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

  console.log('\n📊 Processing complete:', {
    totalCards: data.cards.length,
    cardsFound: results.filter(r => r.match).length,
    cardsNotFound: results.filter(r => !r.match).length,
    totalSuggestedValue,
    totalMaximumValue,
    totalRetailValue
  });

  return {
    success: true,
    estimate: true,
    results,
    suggestedTotal: totalSuggestedValue.toFixed(2),
    maximumTotal: totalMaximumValue.toFixed(2),
    totalRetailValue: totalRetailValue.toFixed(2),
    timestamp: new Date().toISOString(),
    processingStats: {
      totalCards: data.cards.length,
      cardsFound: results.filter(r => r.match).length,
      cardsNotFound: results.filter(r => !r.match).length
    }
  };
}

async function handleGetSubmissions(req, res) {
  const { submissionId, email, status } = req.query;
  
  try {
    let submissions;
    
    if (submissionId) {
      submissions = await getSubmissionById(submissionId);
    } else if (email) {
      submissions = await getSubmissionsByEmail(email);
    } else {
      submissions = await getAllSubmissions({ status });
    }
    
    return res.status(200).json({
      success: true,
      data: submissions
    });
    
  } catch (error) {
    console.error('❌ Failed to fetch submissions:', error);
    return res.status(500).json({
      error: 'Failed to fetch submissions'
    });
  }
}

// Helper Functions

function generateSubmissionId() {
  const prefix = 'TR';
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `${prefix}-${year}-${random}`;
}

const makeShopifyRequest = async (endpoint, options = {}) => {
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  const defaultHeaders = {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };

  return fetch(`https://${SHOPIFY_DOMAIN}${endpoint}`, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers
    }
  });
};

// Store anonymous submissions at shop level
async function storeAnonymousSubmission(submission) {
  console.log('📦 Storing anonymous submission:', submission.id);
  
  try {
    // Get existing anonymous submissions index
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=anonymous_submissions');
    const indexData = await indexResponse.json();
    
    let anonymousSubmissions = [];
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      try {
        anonymousSubmissions = JSON.parse(indexData.metafields[0].value);
      } catch (e) {
        console.warn('Failed to parse existing anonymous submissions, starting fresh');
        anonymousSubmissions = [];
      }
    }
    
    // Add new submission (store full submission data for anonymous)
    anonymousSubmissions.unshift(submission);
    
    // Keep only last 500 anonymous submissions
    if (anonymousSubmissions.length > 500) {
      anonymousSubmissions = anonymousSubmissions.slice(0, 500);
    }
    
    const metafieldPayload = {
      metafield: {
        namespace: 'trade_in_system',
        key: 'anonymous_submissions',
        value: JSON.stringify(anonymousSubmissions),
        type: 'json'
      }
    };
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      await makeShopifyRequest(`/admin/api/2023-10/metafields/${indexData.metafields[0].id}.json`, {
        method: 'PUT',
        body: JSON.stringify(metafieldPayload)
      });
    } else {
      await makeShopifyRequest('/admin/api/2023-10/metafields.json', {
        method: 'POST',
        body: JSON.stringify(metafieldPayload)
      });
    }
    
    console.log('✅ Anonymous submission stored');
    
    // Also update the main submission index
    await storeSubmissionIndex(submission);
    
    return true;
    
  } catch (error) {
    console.error('❌ Failed to store anonymous submission:', error);
    throw error;
  }
}

async function storeSubmission(submission) {
  console.log('📦 Storing submission in Shopify metafields:', submission.id);
  
  try {
    let shopifyCustomer = await findOrCreateShopifyCustomer(submission.customer);
    submission.customer.shopifyId = shopifyCustomer.id;
    
    const metafieldData = {
      metafield: {
        namespace: 'trade_in_submissions',
        key: submission.id,
        value: JSON.stringify(submission),
        type: 'json'
      }
    };
    
    const response = await makeShopifyRequest(
      `/admin/api/2023-10/customers/${shopifyCustomer.id}/metafields.json`,
      {
        method: 'POST',
        body: JSON.stringify(metafieldData)
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to store submission metafield: ${errorText}`);
    }
    
    const result = await response.json();
    console.log('✅ Submission stored in Shopify metafield:', result.metafield.id);
    
    await storeSubmissionIndex(submission);
    
    return true;
    
  } catch (error) {
    console.error('❌ Failed to store submission in Shopify:', error);
    throw error;
  }
}

async function findOrCreateShopifyCustomer(customerData) {
  console.log('👤 Finding or creating Shopify customer:', customerData.email);
  
  try {
    const searchResponse = await makeShopifyRequest(
      `/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(customerData.email)}`
    );
    
    const searchData = await searchResponse.json();
    
    if (searchData.customers && searchData.customers.length > 0) {
      console.log('✅ Found existing customer:', searchData.customers[0].id);
      return searchData.customers[0];
    }
    
    const customerPayload = {
      customer: {
        email: customerData.email,
        first_name: customerData.name.split(' ')[0] || customerData.name,
        last_name: customerData.name.split(' ').slice(1).join(' ') || '',
        phone: customerData.phone || null,
        note: 'Customer created via trade-in portal',
        tags: 'trade-in-customer',
        verified_email: false
      }
    };
    
    const createResponse = await makeShopifyRequest('/admin/api/2023-10/customers.json', {
      method: 'POST',
      body: JSON.stringify(customerPayload)
    });
    
    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Failed to create customer: ${errorText}`);
    }
    
    const customerResult = await createResponse.json();
    console.log('✅ Created new customer:', customerResult.customer.id);
    
    return customerResult.customer;
    
  } catch (error) {
    console.error('❌ Error with customer:', error);
    throw error;
  }
}

async function storeSubmissionIndex(submission) {
  try {
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=submission_index');
    const indexData = await indexResponse.json();
    
    let submissionIndex = [];
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      try {
        submissionIndex = JSON.parse(indexData.metafields[0].value);
      } catch (e) {
        console.warn('Failed to parse existing submission index, starting fresh');
        submissionIndex = [];
      }
    }
    
    const indexEntry = {
      id: submission.id,
      isAnonymous: submission.isAnonymous || false,
      customerId: submission.customer?.shopifyId || null,
      customerEmail: submission.customer?.email || null,
      customerName: submission.customer?.name || 'Walk-in Customer',
      submittedAt: submission.submittedAt,
      status: submission.status,
      payoutMethod: submission.payoutMethod,
      estimatedValue: submission.estimatedValue,
      cardCount: submission.cards.length,
      cardsFound: submission.estimateData?.cardsFound || 0,
      cardsNotFound: submission.estimateData?.cardsNotFound || 0
    };
    
    submissionIndex.unshift(indexEntry);
    
    if (submissionIndex.length > 1000) {
      submissionIndex = submissionIndex.slice(0, 1000);
    }
    
    const indexMetafield = {
      metafield: {
        namespace: 'trade_in_system',
        key: 'submission_index',
        value: JSON.stringify(submissionIndex),
        type: 'json'
      }
    };
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      await makeShopifyRequest(`/admin/api/2023-10/metafields/${indexData.metafields[0].id}.json`, {
        method: 'PUT',
        body: JSON.stringify(indexMetafield)
      });
    } else {
      await makeShopifyRequest('/admin/api/2023-10/metafields.json', {
        method: 'POST',
        body: JSON.stringify(indexMetafield)
      });
    }
    
    console.log('✅ Submission index updated');
    
  } catch (error) {
    console.error('⚠️ Failed to update submission index (non-critical):', error);
  }
}

async function getSubmissionById(submissionId) {
  console.log('🔍 Getting submission by ID from Shopify:', submissionId);
  
  try {
    // First check anonymous submissions
    const anonResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=anonymous_submissions');
    const anonData = await anonResponse.json();
    
    if (anonData.metafields && anonData.metafields.length > 0) {
      const anonSubmissions = JSON.parse(anonData.metafields[0].value);
      const anonSubmission = anonSubmissions.find(s => s.id === submissionId);
      if (anonSubmission) {
        return anonSubmission;
      }
    }
    
    // Then check customer-linked submissions
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=submission_index');
    const indexData = await indexResponse.json();
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      const submissionIndex = JSON.parse(indexData.metafields[0].value);
      const indexEntry = submissionIndex.find(entry => entry.id === submissionId);
      
      if (indexEntry && indexEntry.customerId) {
        const metafieldResponse = await makeShopifyRequest(
          `/admin/api/2023-10/customers/${indexEntry.customerId}/metafields.json?namespace=trade_in_submissions&key=${submissionId}`
        );
        
        const metafieldData = await metafieldResponse.json();
        
        if (metafieldData.metafields && metafieldData.metafields.length > 0) {
          return JSON.parse(metafieldData.metafields[0].value);
        }
      }
    }
    
    console.log('❌ Submission not found:', submissionId);
    return null;
    
  } catch (error) {
    console.error('❌ Error getting submission:', error);
    throw error;
  }
}

async function getSubmissionsByEmail(email) {
  console.log('🔍 Getting submissions by email from Shopify:', email);
  
  try {
    const searchResponse = await makeShopifyRequest(
      `/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`
    );
    
    const searchData = await searchResponse.json();
    
    if (!searchData.customers || searchData.customers.length === 0) {
      return [];
    }
    
    const customer = searchData.customers[0];
    
    const metafieldsResponse = await makeShopifyRequest(
      `/admin/api/2023-10/customers/${customer.id}/metafields.json?namespace=trade_in_submissions`
    );
    
    const metafieldsData = await metafieldsResponse.json();
    
    if (!metafieldsData.metafields) {
      return [];
    }
    
    const submissions = metafieldsData.metafields.map(metafield => {
      try {
        return JSON.parse(metafield.value);
      } catch (e) {
        console.warn('Failed to parse submission metafield:', metafield.id);
        return null;
      }
    }).filter(Boolean);
    
    submissions.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    
    return submissions;
    
  } catch (error) {
    console.error('❌ Error getting submissions by email:', error);
    throw error;
  }
}

async function getAllSubmissions(filters = {}) {
  console.log('🔍 Getting all submissions from Shopify with filters:', filters);
  
  try {
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=submission_index');
    const indexData = await indexResponse.json();
    
    if (!indexData.metafields || indexData.metafields.length === 0) {
      return [];
    }
    
    let submissions = JSON.parse(indexData.metafields[0].value);
    
    if (filters.status) {
      submissions = submissions.filter(sub => sub.status === filters.status);
    }
    
    return submissions;
    
  } catch (error) {
    console.error('❌ Error getting all submissions:', error);
    throw error;
  }
}

async function sendCustomerConfirmationEmail(submission) {
  console.log('📧 Would send confirmation email to customer');
  console.log('Email to:', submission.customer.email);
  console.log('Submission ID:', submission.id);
  
  // TODO: Implement actual email sending
  return true;
}

async function sendAdminNotificationEmail(submission) {
  console.log('📧 Would send admin notification email');
  console.log('New submission:', submission.id);
  
  // TODO: Implement actual email sending
  return true;
}

// Update submission status (for admin use)
async function updateSubmissionStatus(submissionId, status, notes, processedBy) {
  console.log('🔄 Updating submission status:', submissionId, status);
  
  try {
    const submission = await getSubmissionById(submissionId);
    
    if (!submission) {
      throw new Error('Submission not found');
    }
    
    submission.status = status;
    submission.notes = [...(submission.notes || []), ...notes];
    submission.processedBy = processedBy;
    submission.processedAt = new Date().toISOString();
    
    // Handle anonymous vs customer-linked differently
    if (submission.isAnonymous) {
      // Update in anonymous submissions
      const anonResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=anonymous_submissions');
      const anonData = await anonResponse.json();
      
      if (anonData.metafields && anonData.metafields.length > 0) {
        let anonSubmissions = JSON.parse(anonData.metafields[0].value);
        const idx = anonSubmissions.findIndex(s => s.id === submissionId);
        if (idx !== -1) {
          anonSubmissions[idx] = submission;
          
          await makeShopifyRequest(`/admin/api/2023-10/metafields/${anonData.metafields[0].id}.json`, {
            method: 'PUT',
            body: JSON.stringify({
              metafield: {
                value: JSON.stringify(anonSubmissions),
                type: 'json'
              }
            })
          });
        }
      }
    } else {
      // Update customer-linked submission
      const metafieldResponse = await makeShopifyRequest(
        `/admin/api/2023-10/customers/${submission.customer.shopifyId}/metafields.json?namespace=trade_in_submissions&key=${submissionId}`
      );
      
      const metafieldData = await metafieldResponse.json();
      
      if (metafieldData.metafields && metafieldData.metafields.length > 0) {
        const metafieldId = metafieldData.metafields[0].id;
        
        await makeShopifyRequest(`/admin/api/2023-10/metafields/${metafieldId}.json`, {
          method: 'PUT',
          body: JSON.stringify({
            metafield: {
              value: JSON.stringify(submission),
              type: 'json'
            }
          })
        });
      }
    }
    
    await updateSubmissionInIndex(submissionId, { status, processedBy, processedAt: submission.processedAt });
    
    console.log('✅ Submission status updated');
    return submission;
    
  } catch (error) {
    console.error('❌ Error updating submission status:', error);
    throw error;
  }
}

async function updateSubmissionInIndex(submissionId, updates) {
  try {
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=submission_index');
    const indexData = await indexResponse.json();
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      let submissionIndex = JSON.parse(indexData.metafields[0].value);
      
      const submissionIdx = submissionIndex.findIndex(sub => sub.id === submissionId);
      if (submissionIdx !== -1) {
        submissionIndex[submissionIdx] = { ...submissionIndex[submissionIdx], ...updates };
        
        await makeShopifyRequest(`/admin/api/2023-10/metafields/${indexData.metafields[0].id}.json`, {
          method: 'PUT',
          body: JSON.stringify({
            metafield: {
              value: JSON.stringify(submissionIndex),
              type: 'json'
            }
          })
        });
        
        console.log('✅ Submission index updated');
      }
    }
  } catch (error) {
    console.error('⚠️ Failed to update submission in index (non-critical):', error);
  }
}
