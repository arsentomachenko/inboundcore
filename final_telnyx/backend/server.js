require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const EventEmitter = require('events');

// CRITICAL: Create global event emitter BEFORE importing routes
// This ensures webhookRoutes can set up the transcript listener during initialization
global.mediaStreamEvents = new EventEmitter();
console.log('✅ global.mediaStreamEvents created');

// Import routes (AFTER creating global.mediaStreamEvents)
const userRoutes = require('./routes/userRoutes');
const callRoutes = require('./routes/callRoutes');
const didRoutes = require('./routes/didRoutes');
const agentRoutes = require('./routes/agentRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const conversationRoutes = require('./routes/conversationRoutes');

// Import services
const { initializeWebSocketServer } = require('./services/websocketService');
const { initializeMediaStreamServer } = require('./services/mediaStreamingService');
const telnyxService = require('./services/telnyxService');
const { didRotation } = require('./routes/didRoutes');
const { initializeDatabase } = require('./config/database');
const costTracking = require('./services/costTrackingService');
const { transferredCalls } = require('./routes/agentRoutes');

const app = express();
const server = http.createServer(app);

// Auto-initialize DID rotation with all purchased numbers
async function autoInitializeDIDRotation() {
  try {
    console.log('🔄 Auto-initializing DID rotation...');
    const numbers = await telnyxService.getPurchasedNumbers();
    
    if (numbers.length === 0) {
      console.log('⚠️  No purchased DIDs found. Please purchase phone numbers in Telnyx Portal.');
      return;
    }

    const phoneNumbers = numbers.map(n => n.phone_number);
    
    // Import helper functions
    const didRoutes = require('./routes/didRoutes');
    
    // Organize numbers by location
    const { byState, byAreaCode } = didRoutes.organizeNumbersByLocation 
      ? didRoutes.organizeNumbersByLocation(phoneNumbers)
      : { byState: {}, byAreaCode: {} };
    
    // Update rotation
    didRotation.enabled = true;
    didRotation.strategy = 'area_code';
    didRotation.numbersByState = byState;
    didRotation.numbersByAreaCode = byAreaCode;
    didRotation.allNumbers = phoneNumbers;
    didRotation.currentIndex = 0;
    
    console.log(`✅ DID Rotation initialized: ${phoneNumbers.length} numbers across ${Object.keys(byState).length} states`);
    console.log(`📍 States: ${Object.keys(byState).join(', ')}`);
    console.log(`📞 DIDs: ${phoneNumbers.join(', ')}`);
  } catch (error) {
    console.error('❌ Error auto-initializing DID rotation:', error.message);
  }
}

// Function to organize numbers by location (if not exported from didRoutes)
function organizeNumbersByLocation(numbers) {
  const byState = {};
  const byAreaCode = {};
  
  const areaCodeToState = {
    '212': 'NY', '646': 'NY', '718': 'NY', '917': 'NY', '347': 'NY',
    '213': 'CA', '310': 'CA', '323': 'CA', '424': 'CA', '626': 'CA',
    '305': 'FL', '786': 'FL', '954': 'FL', '561': 'FL',
    '312': 'IL', '773': 'IL', '872': 'IL',
    '214': 'TX', '469': 'TX', '972': 'TX', '682': 'TX', '817': 'TX',
    '404': 'GA', '678': 'GA', '770': 'GA',
    '843': 'SC', '864': 'SC',
    '202': 'DC'
  };
  
  numbers.forEach(number => {
    const digits = number.replace(/\D/g, '');
    if (digits.length >= 10) {
      const areaCode = digits.substring(digits.length - 10, digits.length - 7);
      const state = areaCodeToState[areaCode] || 'Unknown';
      
      if (!byState[state]) byState[state] = [];
      byState[state].push(number);
      
      if (!byAreaCode[areaCode]) byAreaCode[areaCode] = [];
      byAreaCode[areaCode].push(number);
    }
  });
  
  return { byState, byAreaCode };
}

// Middleware
const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  : ['http://localhost:5000'];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/did', didRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/webhooks', webhookRoutes);

// Initialize WebSocket Server
const wss = initializeWebSocketServer(server);

// Initialize Media Streaming Server for Telnyx audio + Deepgram STT
const mediaWss = initializeMediaStreamServer(server);

// Central upgrade handler - route to correct WebSocket server based on path
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  console.log(`🔍 Upgrade request:`);
  console.log(`   Path: ${pathname}`);
  console.log(`   From: ${socket.remoteAddress}`);
  
  if (pathname === '/ws') {
    console.log(`   → Routing to main WebSocket server`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`✅ WebSocket upgrade completed for /ws`);
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/media-stream') {
    console.log(`   → Routing to media streaming server`);
    mediaWss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`✅ WebSocket upgrade completed for /media-stream`);
      mediaWss.emit('connection', ws, request);
    });
  } else {
    console.log(`   → Unknown path, destroying socket`);
    socket.destroy();
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; // Bind to IPv4 (required for Telnyx to connect)

server.listen(PORT, HOST, async () => {
  console.log(`✅ Server running on ${HOST}:${PORT}`);
  console.log(`✅ WebSocket server initialized`);
  console.log(`✅ Environment: ${process.env.NODE_ENV}`);
  
  // Initialize database
  try {
    await initializeDatabase();
    
    // Reload data from database now that tables exist
    console.log('🔄 Reloading data from database...');
    await costTracking.loadCosts();
    
    // Reload transferred calls
    const agentRoutes = require('./routes/agentRoutes');
    if (agentRoutes.loadTransferredCalls) {
      await agentRoutes.loadTransferredCalls();
    }
  } catch (error) {
    console.error('❌ Failed to initialize database:', error.message);
    console.error('   Make sure PostgreSQL is running and credentials are correct');
  }
  
  // Auto-initialize DID rotation
  await autoInitializeDIDRotation();
  
  // Register ElevenLabs API key with Telnyx if configured
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      await telnyxService.registerElevenLabsSecret();
    } catch (error) {
      // Error already logged in telnyxService, just prevent server crash
      console.warn('⚠️  Server will continue without ElevenLabs-Telnyx integration');
    }
  }
});

module.exports = { app, server, wss };

