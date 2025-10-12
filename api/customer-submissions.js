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

  // Validation
  if (!customerName || !customerEmail || !payoutMethod || !cards || !Array.isArray(cards)) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['customerName', 'customerEmail', 'payoutMethod', 'cards']
    });
  }

  if (cards.length === 0) {
    return res.status(400).json({ error: 'At least one card is required' });
  }

  // Email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(customerEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Generate unique submission ID
  const submissionId = generateSubmissionId();
  
  console.log('📝 Processing customer submission:', submissionId);
  console.log('🃏 Cards to process:', cards.length);

  try {
    // ✨ NEW: Process cards through main trade-in system to get LIVE pricing
    console.log('🔄 Getting live pricing estimates from trade-in system...');
    
    const estimateData = await getEstimateFromTradeInSystem({
      cards: cards,
      customerEmail: customerEmail,
      payoutMethod: payoutMethod
    });

    console.log('✅ Live estimate received:', {
      suggestedTotal: estimateData.suggestedTotal,
      cardsFound: estimateData.results.filter(r => r.match).length,
      cardsNotFound: estimateData.results.filter(r => !r.match).length
    });

    // Create submission object with LIVE data
    const submission = {
      id: submissionId,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      customer: {
        name: customerName,
        email: customerEmail,
        phone: customerPhone || null
      },
      payoutMethod,
      cards: cards.map((card, index) => {
        // Enhance card data with actual search results
        const result = estimateData.results[index];
        return {
          cardName: card.cardName,
          quantity: parseInt(card.quantity) || 1,
          condition: card.condition || 'NM',
          sku: result?.sku || card.sku || null,
          searchMethod: card.searchMethod || 'manual',
          // Add live pricing data
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

    console.log('📦 Storing submission with live pricing data...');

    // Store in Shopify
    await storeSubmission(submission);
    
    // Send confirmation email to customer
    await sendCustomerConfirmationEmail(submission);
    
    // Send notification to admin/staff
    await sendAdminNotificationEmail(submission);
    
    console.log('✅ Submission processed successfully:', submissionId);
    
    return res.status(201).json({
      success: true,
      submissionId: submissionId,
      status: 'pending',
      message: 'Your trade-in request has been submitted successfully!',
      estimate: {
        suggestedTotal: submission.estimatedValue.toFixed(2),
        maximumTotal: parseFloat(estimateData.maximumTotal).toFixed(2),
        totalRetailValue: parseFloat(estimateData.totalRetailValue).toFixed(2),
        cardsProcessed: cards.length,
        cardsFound: estimateData.processingStats.cardsFound,
        cardsNotFound: estimateData.processingStats.cardsNotFound
      },
      estimatedProcessingTime: '24 hours',
      nextSteps: [
        'You will receive a confirmation email shortly',
        'Our team will review your cards and confirm the final payout',
        'We will contact you within 24 hours with next steps'
      ],
      // Include detailed card results for transparency
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
    return res.status(500).json({
      error: 'Failed to process submission',
      details: 'Please try again or contact support',
      technicalDetails: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ✨ NEW: Function to get live estimates from your main trade-in system
async function getEstimateFromTradeInSystem(data) {
  console.log('🔄 Calling main trade-in API for estimate...');
  
  // Import or require your main trade-in logic
  // Option A: If they're in the same codebase, import the logic directly
  // Option B: Make an internal API call
  
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  // Validate required environment variables
  if (!SHOPIFY_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Missing required Shopify credentials');
  }

  // Use the SAME logic from your main trade-in API
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

  // Trade rate calculation functions (same as main API)
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

  // Search functions (same as main API)
  function normalizeSearchTerm(term) {
    if (!term) return '';
    const normalized = term.replace(/[\/\-\s]/g, '');
    return normalized;
  }

  function extractPotentialTags(cardName) {
    if (!cardName) return [];
    
    const tags = [];
    const numberPattern = /(\d+)[\/\-](\d+)/g;
    let match;
    
    while ((match = numberPattern.exec(cardName)) !== null) {
      tags.push(match[0]);
      tags.push(match[1] + match[2]);
    }
    
    const standaloneNumbers = cardName.match(/\b\d{3,6}\b/g);
    if (standaloneNumbers) {
      tags.push(...standaloneNumbers);
    }
    
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

    // Get first variant from first product (simplified for estimate)
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
    
    // Try tag search first
    const potentialTags = extractPotentialTags(cardName);
    
    for (const tag of potentialTags) {
      if (!tag || tag.length < 2) continue;
      
      try {
        const result = await searchByTagWithAllOptions(tag, cardName);
        if (result.found) {
          return result;
        }
      } catch (error) {
        continue;
      }
    }
    
    // Fallback to title search
    try {
      const result = await searchByTitle(cardName);
      if (result.found) {
        return result;
      }
    } catch (error) {
      console.log('Title search failed:', error.message);
    }
    
    return { found: false };
  };

  // Process all cards
  let totalSuggestedValue = 0;
  let totalMaximumValue = 0;
  let totalRetailValue = 0;
  const results = [];

  for (const card of data.cards) {
    const { cardName, quantity = 1, condition = 'NM' } = card;
    
    const searchResult = await searchCard(card);
    
    if (!searchResult.found) {
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
      customerId: submission.customer.shopifyId,
      customerEmail: submission.customer.email,
      customerName: submission.customer.name,
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
  
  const emailContent = {
    to: submission.customer.email,
    subject: `Trade-in Request Confirmation - ${submission.id}`,
    html: `
      <h2>Trade-in Request Received!</h2>
      <p>Dear ${submission.customer.name},</p>
      <p>Thank you for your trade-in request. We've received your submission and will review it within 24 hours.</p>
      
      <div style="background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px;">
        <strong>Submission ID:</strong> ${submission.id}<br>
        <strong>Customer:</strong> ${submission.customer.name} (${submission.customer.email})<br>
        <strong>Phone:</strong> ${submission.customer.phone || 'Not provided'}<br>
        <strong>Payout Method:</strong> ${submission.payoutMethod}<br>
        <strong>Cards:</strong> ${submission.cards.length} items<br>
        <strong>Estimated Value:</strong> ${submission.estimatedValue.toFixed(2)} CAD<br>
        <strong>Cards Found:</strong> ${submission.estimateData?.cardsFound || 0} / ${submission.cards.length}<br>
        <strong>Cards Needing Review:</strong> ${submission.estimateData?.cardsNotFound || 0}
      </div>
      
      <p><strong>Cards with Live Pricing:</strong></p>
      <ul>
        ${submission.cards.map(card => 
          `<li>${card.cardName} (Qty: ${card.quantity}, Condition: ${card.condition})
          ${card.matchFound ? `<br>✅ Matched: ${card.matchedProduct} - Retail: ${card.retailPrice}, Trade: ${card.suggestedTradeValue}` : '<br>⚠️ No match found - needs manual review'}</li>`
        ).join('')}
      </ul>
      
      <p><strong>Summary:</strong></p>
      <ul>
        <li>Total Retail Value: ${submission.estimateData?.totalRetailValue || 0}</li>
        <li>Suggested Trade-in: ${submission.estimatedValue.toFixed(2)}</li>
        <li>Maximum Possible: ${submission.estimateData?.maximumTotal || 0}</li>
      </ul>
      
      <p>Please review and process this submission within 24 hours.</p>
    `
  };
  
  // TODO: Implement actual email sending here
  
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
}px;">
        <strong>Submission Details:</strong><br>
        <strong>ID:</strong> ${submission.id}<br>
        <strong>Submitted:</strong> ${new Date(submission.submittedAt).toLocaleString()}<br>
        <strong>Cards:</strong> ${submission.cards.length} items<br>
        <strong>Payout Method:</strong> ${submission.payoutMethod}<br>
        <strong>Estimated Value:</strong> $${submission.estimatedValue.toFixed(2)} CAD
      </div>
      
      <p><strong>Your Cards:</strong></p>
      <ul>
        ${submission.cards.map(card => 
          `<li>${card.cardName} (Qty: ${card.quantity}) - ${card.matchFound ? `✅ Match found: $${(card.suggestedTradeValue * card.quantity).toFixed(2)}` : '⚠️ Needs manual review'}</li>`
        ).join('')}
      </ul>
      
      <p><strong>Next Steps:</strong></p>
      <ul>
        <li>Our team will review your cards and confirm the final payout</li>
        <li>We'll contact you within 24 hours with next steps</li>
        <li>Keep this email for your records</li>
      </ul>
      
      <p>If you have any questions, please contact us and reference your submission ID: ${submission.id}</p>
      
      <p>Thank you!</p>
    `
  };
  
  // TODO: Implement actual email sending here
  // You could use SendGrid, Nodemailer, or Shopify's email system
  
  return true;
}

async function sendAdminNotificationEmail(submission) {
  console.log('📧 Would send admin notification email');
  console.log('New submission:', submission.id);
  
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@yourstore.com';
  
  const emailContent = {
    to: adminEmail,
    subject: `New Trade-in Submission - ${submission.id}`,
    html: `
      <h2>New Trade-in Submission</h2>
      <p>A new customer trade-in request has been submitted with LIVE pricing estimates.</p>
      
      <div style="background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5
