const express = require('express');
const router = express.Router();
const telnyxService = require('../services/telnyxService');

// DID rotation state with area code/state grouping
let didRotation = {
  enabled: false,
  strategy: 'area_code', // 'area_code' or 'round_robin'
  numbersByState: {}, // { 'NY': ['+1234567890', '+1234567891'], 'CA': [...] }
  numbersByAreaCode: {}, // { '212': ['+1234567890'], '213': [...] }
  allNumbers: [],
  currentIndex: 0
};

// Area code to state mapping (top US area codes)
const areaCodeToState = {
  '212': 'NY', '646': 'NY', '718': 'NY', '917': 'NY', '347': 'NY',
  '213': 'CA', '310': 'CA', '323': 'CA', '424': 'CA', '626': 'CA', '747': 'CA', '818': 'CA',
  '305': 'FL', '786': 'FL', '954': 'FL', '561': 'FL', '754': 'FL',
  '312': 'IL', '773': 'IL', '872': 'IL',
  '214': 'TX', '469': 'TX', '972': 'TX', '682': 'TX', '817': 'TX',
  '404': 'GA', '678': 'GA', '770': 'GA',
  '202': 'DC', '571': 'VA', '703': 'VA',
  '617': 'MA', '857': 'MA', '781': 'MA',
  '206': 'WA', '253': 'WA', '425': 'WA',
  '602': 'AZ', '480': 'AZ', '623': 'AZ',
  '702': 'NV', '725': 'NV',
  '503': 'OR', '971': 'OR',
  '303': 'CO', '720': 'CO',
  '615': 'TN', '629': 'TN', '901': 'TN',
  '704': 'NC', '980': 'NC', '919': 'NC',
  '216': 'OH', '614': 'OH', '513': 'OH',
  '215': 'PA', '267': 'PA', '610': 'PA',
  '313': 'MI', '248': 'MI', '734': 'MI',
  '410': 'MD', '443': 'MD',
  '201': 'NJ', '973': 'NJ', '732': 'NJ',
  '317': 'IN', '463': 'IN',
  '414': 'WI', '262': 'WI',
  '502': 'KY', '859': 'KY',
  '505': 'NM',
  '401': 'RI',
  '801': 'UT', '385': 'UT',
  '843': 'SC', '843': 'SC', '864': 'SC'
};

// Helper function to extract area code from phone number
function extractAreaCode(phoneNumber) {
  // Remove +1 and any non-digits
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.substring(digits.length - 10, digits.length - 7);
  }
  return null;
}

// Helper function to get state from area code
function getStateFromAreaCode(areaCode) {
  return areaCodeToState[areaCode] || 'Unknown';
}

// Helper function to organize numbers by area code and state
function organizeNumbersByLocation(numbers) {
  const byState = {};
  const byAreaCode = {};
  
  numbers.forEach(number => {
    const areaCode = extractAreaCode(number);
    if (areaCode) {
      const state = getStateFromAreaCode(areaCode);
      
      // Group by state
      if (!byState[state]) {
        byState[state] = [];
      }
      byState[state].push(number);
      
      // Group by area code
      if (!byAreaCode[areaCode]) {
        byAreaCode[areaCode] = [];
      }
      byAreaCode[areaCode].push(number);
    }
  });
  
  return { byState, byAreaCode };
}

/**
 * GET /api/did/available - Get available phone numbers
 */
router.get('/available', async (req, res) => {
  try {
    const { areaCode } = req.query;
    const numbers = await telnyxService.getAvailableNumbers(areaCode);
    
    res.json({
      success: true,
      data: numbers
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/did/purchased - Get purchased phone numbers
 */
router.get('/purchased', async (req, res) => {
  try {
    const numbers = await telnyxService.getPurchasedNumbers();
    
    res.json({
      success: true,
      data: numbers
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/did/purchase - Purchase a phone number
 */
router.post('/purchase', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required'
      });
    }

    const result = await telnyxService.purchaseNumber(phoneNumber);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/did/rotation - Get DID rotation settings
 */
router.get('/rotation', (req, res) => {
  res.json({
    success: true,
    data: didRotation
  });
});

/**
 * POST /api/did/rotation/configure - Configure DID rotation with area code/state grouping
 */
router.post('/rotation/configure', async (req, res) => {
  try {
    const { numbers, enabled, strategy } = req.body;

    if (!Array.isArray(numbers)) {
      return res.status(400).json({
        success: false,
        error: 'numbers array is required'
      });
    }

    // Organize numbers by location
    const { byState, byAreaCode } = organizeNumbersByLocation(numbers);

    didRotation = {
      enabled: enabled !== undefined ? enabled : didRotation.enabled,
      strategy: strategy || 'area_code', // 'area_code' or 'round_robin'
      numbersByState: byState,
      numbersByAreaCode: byAreaCode,
      allNumbers: numbers,
      currentIndex: 0
    };

    console.log(`📍 DID Rotation configured: ${numbers.length} numbers across ${Object.keys(byState).length} states`);
    console.log('States:', Object.keys(byState).join(', '));

    res.json({
      success: true,
      data: {
        ...didRotation,
        summary: {
          totalNumbers: numbers.length,
          states: Object.keys(byState).length,
          areaCodes: Object.keys(byAreaCode).length,
          stateBreakdown: Object.keys(byState).map(state => ({
            state,
            count: byState[state].length
          }))
        }
      },
      message: 'DID rotation configured successfully with area code grouping'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/did/rotation/toggle - Enable/disable DID rotation
 */
router.post('/rotation/toggle', (req, res) => {
  try {
    didRotation.enabled = !didRotation.enabled;
    
    res.json({
      success: true,
      data: didRotation,
      message: `DID rotation ${didRotation.enabled ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/did/rotation/next - Get next number in rotation (round-robin)
 */
router.get('/rotation/next', (req, res) => {
  try {
    if (!didRotation.enabled || didRotation.allNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'DID rotation is not enabled or no numbers configured'
      });
    }

    const number = didRotation.allNumbers[didRotation.currentIndex];
    
    // Increment index for next call
    didRotation.currentIndex = (didRotation.currentIndex + 1) % didRotation.allNumbers.length;

    res.json({
      success: true,
      data: {
        number,
        nextIndex: didRotation.currentIndex
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/did/rotation/match - Get DID matching recipient's area code/state
 */
router.post('/rotation/match', (req, res) => {
  try {
    const { recipientPhone, recipientState } = req.body;

    if (!didRotation.enabled || didRotation.allNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'DID rotation is not enabled or no numbers configured'
      });
    }

    let matchedNumber = null;
    let matchType = null;

    // Strategy 1: Match by area code (highest priority)
    if (recipientPhone && didRotation.strategy === 'area_code') {
      const recipientAreaCode = extractAreaCode(recipientPhone);
      if (recipientAreaCode && didRotation.numbersByAreaCode[recipientAreaCode]) {
        const numbers = didRotation.numbersByAreaCode[recipientAreaCode];
        matchedNumber = numbers[Math.floor(Math.random() * numbers.length)];
        matchType = `area_code_${recipientAreaCode}`;
        // Removed verbose logging (called repeatedly by frontend)
      }
    }

    // Strategy 2: Match by state (fallback)
    if (!matchedNumber && recipientState && didRotation.numbersByState[recipientState]) {
      const numbers = didRotation.numbersByState[recipientState];
      matchedNumber = numbers[Math.floor(Math.random() * numbers.length)];
      matchType = `state_${recipientState}`;
      // Removed verbose logging (called repeatedly by frontend)
    }

    // Strategy 3: Round-robin fallback
    if (!matchedNumber) {
      matchedNumber = didRotation.allNumbers[didRotation.currentIndex];
      didRotation.currentIndex = (didRotation.currentIndex + 1) % didRotation.allNumbers.length;
      matchType = 'round_robin_fallback';
      // Removed verbose logging (called repeatedly by frontend)
    }

    res.json({
      success: true,
      data: {
        number: matchedNumber,
        matchType,
        recipientAreaCode: extractAreaCode(recipientPhone),
        recipientState
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.didRotation = didRotation;
module.exports.extractAreaCode = extractAreaCode;
module.exports.getStateFromAreaCode = getStateFromAreaCode;
module.exports.areaCodeToState = areaCodeToState;
module.exports.organizeNumbersByLocation = organizeNumbersByLocation;

