// api/customer-submissions.js
// This handles customer trade-in submissions

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
    cards,
    estimateData 
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
  
  // Create submission object
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
    cards: cards.map(card => ({
      cardName: card.cardName,
      quantity: parseInt(card.quantity) || 1,
      condition: card.condition || 'NM',
      sku: card.sku || null,
      searchMethod: card.searchMethod || 'manual'
    })),
    estimateData: estimateData || null,
    estimatedValue: estimateData?.suggestedTotal || null,
    notes: [],
    processedBy: null,
    processedAt: null
  };

  console.log('📝 Creating submission:', submissionId);

  try {
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
      estimatedProcessingTime: '24 hours',
      nextSteps: [
        'You will receive a confirmation email shortly',
        'Our team will review your cards and confirm the final payout',
        'We will contact you within 24 hours with next steps'
      ]
    });

  } catch (error) {
    console.error('❌ Failed to process submission:', error);
    return res.status(500).json({
      error: 'Failed to process submission',
      details: 'Please try again or contact support'
    });
  }
}

async function handleGetSubmissions(req, res) {
  const { submissionId, email, status } = req.query;
  
  try {
    let submissions;
    
    if (submissionId) {
      // Get specific submission
      submissions = await getSubmissionById(submissionId);
    } else if (email) {
      // Get submissions by customer email
      submissions = await getSubmissionsByEmail(email);
    } else {
      // Get all submissions (admin only - you might want to add auth here)
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

// Helper function for authenticated Shopify API requests
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

// Helper function for GraphQL requests
const makeShopifyGraphQLRequest = async (query, variables = {}) => {
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  return fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2023-10/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ 
      query,
      variables
    })
  });
};

async function storeSubmission(submission) {
  console.log('📦 Storing submission in Shopify metafields:', submission.id);
  
  try {
    // First, create or find the customer in Shopify
    let shopifyCustomer = await findOrCreateShopifyCustomer(submission.customer);
    
    // Add the Shopify customer ID to the submission
    submission.customer.shopifyId = shopifyCustomer.id;
    
    // Store the submission as a metafield on the customer
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
    
    // Also store an index metafield for easier querying
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
    // Search for existing customer by email
    const searchResponse = await makeShopifyRequest(
      `/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(customerData.email)}`
    );
    
    const searchData = await searchResponse.json();
    
    if (searchData.customers && searchData.customers.length > 0) {
      console.log('✅ Found existing customer:', searchData.customers[0].id);
      return searchData.customers[0];
    }
    
    // Create new customer if not found
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
  // Store a summary index for easier admin querying
  try {
    // Get current submission index
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
    
    // Add new submission to index
    const indexEntry = {
      id: submission.id,
      customerId: submission.customer.shopifyId,
      customerEmail: submission.customer.email,
      customerName: submission.customer.name,
      submittedAt: submission.submittedAt,
      status: submission.status,
      payoutMethod: submission.payoutMethod,
      estimatedValue: submission.estimatedValue,
      cardCount: submission.cards.length
    };
    
    submissionIndex.unshift(indexEntry); // Add to beginning
    
    // Keep only last 1000 submissions in index
    if (submissionIndex.length > 1000) {
      submissionIndex = submissionIndex.slice(0, 1000);
    }
    
    // Store updated index
    const indexMetafield = {
      metafield: {
        namespace: 'trade_in_system',
        key: 'submission_index',
        value: JSON.stringify(submissionIndex),
        type: 'json'
      }
    };
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      // Update existing metafield
      await makeShopifyRequest(`/admin/api/2023-10/metafields/${indexData.metafields[0].id}.json`, {
        method: 'PUT',
        body: JSON.stringify(indexMetafield)
      });
    } else {
      // Create new metafield
      await makeShopifyRequest('/admin/api/2023-10/metafields.json', {
        method: 'POST',
        body: JSON.stringify(indexMetafield)
      });
    }
    
    console.log('✅ Submission index updated');
    
  } catch (error) {
    console.error('⚠️ Failed to update submission index (non-critical):', error);
    // This is non-critical, so we don't throw
  }
}

async function getSubmissionById(submissionId) {
  console.log('🔍 Getting submission by ID from Shopify:', submissionId);
  
  try {
    // Get the submission index first to find which customer it belongs to
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=submission_index');
    const indexData = await indexResponse.json();
    
    if (indexData.metafields && indexData.metafields.length > 0) {
      const submissionIndex = JSON.parse(indexData.metafields[0].value);
      const indexEntry = submissionIndex.find(entry => entry.id === submissionId);
      
      if (indexEntry && indexEntry.customerId) {
        // Get the full submission from the customer's metafields
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
    // Find the customer first
    const searchResponse = await makeShopifyRequest(
      `/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`
    );
    
    const searchData = await searchResponse.json();
    
    if (!searchData.customers || searchData.customers.length === 0) {
      return [];
    }
    
    const customer = searchData.customers[0];
    
    // Get all trade-in submission metafields for this customer
    const metafieldsResponse = await makeShopifyRequest(
      `/admin/api/2023-10/customers/${customer.id}/metafields.json?namespace=trade_in_submissions`
    );
    
    const metafieldsData = await metafieldsResponse.json();
    
    if (!metafieldsData.metafields) {
      return [];
    }
    
    // Parse all submissions
    const submissions = metafieldsData.metafields.map(metafield => {
      try {
        return JSON.parse(metafield.value);
      } catch (e) {
        console.warn('Failed to parse submission metafield:', metafield.id);
        return null;
      }
    }).filter(Boolean);
    
    // Sort by submission date (newest first)
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
    // Get the submission index which contains summary info
    const indexResponse = await makeShopifyRequest('/admin/api/2023-10/metafields.json?namespace=trade_in_system&key=submission_index');
    const indexData = await indexResponse.json();
    
    if (!indexData.metafields || indexData.metafields.length === 0) {
      return [];
    }
    
    let submissions = JSON.parse(indexData.metafields[0].value);
    
    // Apply filters
    if (filters.status) {
      submissions = submissions.filter(sub => sub.status === filters.status);
    }
    
    // For admin purposes, we return the summary data
    // If full details are needed, you'd need to fetch each individual submission
    return submissions;
    
  } catch (error) {
    console.error('❌ Error getting all submissions:', error);
    throw error;
  }
}

async function sendCustomerConfirmationEmail(submission) {
  // IMPLEMENT YOUR EMAIL SERVICE HERE
  // For now, we'll just log what would be sent
  console.log('📧 Would send confirmation email to customer');
  console.log('Email to:', submission.customer.email);
  console.log('Submission ID:', submission.id);
  
  // Example email content that would be sent:
  const emailContent = {
    to: submission.customer.email,
    subject: `Trade-in Request Confirmation - ${submission.id}`,
    html: `
      <h2>Trade-in Request Received!</h2>
      <p>Dear ${submission.customer.name},</p>
      <p>Thank you for your trade-in request. We've received your submission and will review it within 24 hours.</p>
      
      <div style="background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px;">
        <strong>Submission Details:</strong><br>
        <strong>ID:</strong> ${submission.id}<br>
        <strong>Submitted:</strong> ${new Date(submission.submittedAt).toLocaleString()}<br>
        <strong>Cards:</strong> ${submission.cards.length} items<br>
        <strong>Payout Method:</strong> ${submission.payoutMethod}<br>
        ${submission.estimatedValue ? `<strong>Estimated Value:</strong> $${submission.estimatedValue}` : ''}
      </div>
      
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
  // IMPLEMENT: Send notification to admin/staff
  console.log('📧 Would send admin notification email');
  console.log('New submission:', submission.id);
  
  // You might want to send this to your team's email or Slack
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@yourstore.com';
  
  const emailContent = {
    to: adminEmail,
    subject: `New Trade-in Submission - ${submission.id}`,
    html: `
      <h2>New Trade-in Submission</h2>
      <p>A new customer trade-in request has been submitted.</p>
      
      <div style="background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px;">
        <strong>Submission ID:</strong> ${submission.id}<br>
        <strong>Customer:</strong> ${submission.customer.name} (${submission.customer.email})<br>
        <strong>Phone:</strong> ${submission.customer.phone || 'Not provided'}<br>
        <strong>Payout Method:</strong> ${submission.payoutMethod}<br>
        <strong>Cards:</strong> ${submission.cards.length} items<br>
        <strong>Estimated Value:</strong> ${submission.estimatedValue ? `$${submission.estimatedValue}` : 'Not estimated'}
      </div>
      
      <p><strong>Cards:</strong></p>
      <ul>
        ${submission.cards.map(card => 
          `<li>${card.cardName} (Qty: ${card.quantity}, Condition: ${card.condition})</li>`
        ).join('')}
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
    // Get the current submission
    const submission = await getSubmissionById(submissionId);
    
    if (!submission) {
      throw new Error('Submission not found');
    }
    
    // Update the submission
    submission.status = status;
    submission.notes = [...(submission.notes || []), ...notes];
    submission.processedBy = processedBy;
    submission.processedAt = new Date().toISOString();
    
    // Update the metafield
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
    
    // Update the index as well
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
      
      // Find and update the submission in the index
      const submissionIdx = submissionIndex.findIndex(sub => sub.id === submissionId);
      if (submissionIdx !== -1) {
        submissionIndex[submissionIdx] = { ...submissionIndex[submissionIdx], ...updates };
        
        // Update the metafield
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
