// buybackstep4.js - Simplified Working Version for Testing
module.exports = async function handler(req, res) {
  console.log('=== API REQUEST START ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Body:', req.body);

  try {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle OPTIONS
    if (req.method === 'OPTIONS') {
      console.log('OPTIONS request - sending CORS headers');
      return res.status(200).end();
    }

    // Handle GET for testing
    if (req.method === 'GET') {
      console.log('GET request - sending test response');
      return res.status(200).json({
        success: true,
        message: 'API is working!',
        method: 'GET',
        timestamp: new Date().toISOString()
      });
    }

    // Handle POST for card search
    if (req.method === 'POST') {
      console.log('POST request - processing card search');

      const { cards, employeeName, payoutMethod } = req.body;
      
      if (!cards || !Array.isArray(cards) || cards.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Cards array is required'
        });
      }

      const cardName = cards[0]?.cardName;
      console.log('Searching for card:', cardName);

      // Simple mock response for testing
      const mockResult = {
        cardName: cardName,
        match: cardName.includes('Lightning') ? 'Lightning Bolt' : null,
        sku: cardName.includes('Lightning') ? 'MTG-LB-001' : null,
        retailPrice: cardName.includes('Lightning') ? 5.99 : 0,
        suggestedTradeValue: cardName.includes('Lightning') ? 3.50 : 0,
        maximumTradeValue: cardName.includes('Lightning') ? 4.20 : 0,
        quantity: cards[0]?.quantity || 1,
        condition: 'NM',
        searchMethod: 'mock'
      };

      const response = {
        success: true,
        results: [mockResult],
        searchInfo: {
          query: cardName,
          matchFound: !!mockResult.match,
          employee: employeeName,
          payoutMethod: payoutMethod,
          timestamp: new Date().toISOString()
        }
      };

      console.log('Sending response:', response);
      return res.status(200).json(response);
    }

    // Method not allowed
    return res.status(405).json({
      success: false,
      error: `Method ${req.method} not allowed`
    });

  } catch (error) {
    console.error('API ERROR:', error);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
