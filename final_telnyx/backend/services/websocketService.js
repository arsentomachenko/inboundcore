const WebSocket = require('ws');
const telnyxService = require('./telnyxService');
const openaiService = require('./openaiService');

let wss = null;
const activeConnections = new Map();

/**
 * Initialize WebSocket Server for real-time communication
 */
function initializeWebSocketServer(server) {
  wss = new WebSocket.Server({ 
    noServer: true  // Manual upgrade handling for better control
  });

  wss.on('error', (error) => {
    console.error(`❌ WebSocket SERVER error:`, error);
  });

  wss.on('connection', (ws, req) => {
    const connectionId = generateConnectionId();
    console.log(`🔌 WebSocket client connected: ${connectionId}`);

    activeConnections.set(connectionId, {
      ws,
      callControlId: null,
      userInfo: null,
      startTime: Date.now()
    });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        await handleWebSocketMessage(connectionId, data);
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 WebSocket client disconnected: ${connectionId}`);
      console.log(`   Close code: ${code}, reason: ${reason || 'none'}`);
      activeConnections.delete(connectionId);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    // Send connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      connectionId,
      timestamp: Date.now()
    }));
  });

  console.log('✅ WebSocket server initialized on /ws');
  return wss;
}

/**
 * Handle incoming WebSocket messages
 */
async function handleWebSocketMessage(connectionId, data) {
  const connection = activeConnections.get(connectionId);
  if (!connection) return;

  const { ws } = connection;

  switch (data.type) {
    case 'audio_chunk':
      // Handle incoming audio from Telnyx (for STT)
      await handleAudioChunk(connectionId, data);
      break;

    case 'transcription':
      // Handle transcription from Deepgram Nova 2 (via Telnyx)
      await handleTranscription(connectionId, data);
      break;

    case 'call_state':
      // Update call state
      connection.callControlId = data.callControlId;
      connection.userInfo = data.userInfo;
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    default:
      console.log(`Unknown message type: ${data.type}`);
  }
}

/**
 * Handle audio chunks (for future enhancements)
 */
async function handleAudioChunk(connectionId, data) {
  // This can be used for custom audio processing if needed
  // For now, we rely on Telnyx's built-in STT
}

/**
 * Handle transcription from Telnyx
 */
async function handleTranscription(connectionId, data) {
  const connection = activeConnections.get(connectionId);
  if (!connection) return;

  const { callControlId, userInfo } = connection;
  const { transcript, is_final } = data;

  // Only process final transcripts
  if (!is_final) return;

  console.log(`📝 Transcription: ${transcript}`);

  try {
    // Get AI response
    const aiResponse = await openaiService.getNextResponse(
      callControlId,
      transcript
    );

    console.log(`🤖 AI Response: ${aiResponse.response}`);

    // Send response back to client
    connection.ws.send(JSON.stringify({
      type: 'ai_response',
      transcript,
      response: aiResponse.response,
      stage: aiResponse.stage,
      shouldHangup: aiResponse.shouldHangup,
      shouldTransfer: aiResponse.shouldTransfer
    }));

    // Use Telnyx TTS to speak the response
    if (callControlId) {
      await telnyxService.speak(callControlId, aiResponse.response);

      // Handle call actions
      if (aiResponse.shouldHangup) {
        setTimeout(async () => {
          await telnyxService.hangupCall(callControlId);
          openaiService.endConversation(callControlId);
        }, 2000); // Wait 2 seconds before hanging up
      } else if (aiResponse.shouldTransfer) {
        // Transfer to agent (you'll need to configure the transfer number)
        setTimeout(async () => {
          const transferNumber = process.env.AGENT_TRANSFER_NUMBER;
          if (transferNumber) {
            await telnyxService.transferCall(callControlId, transferNumber);
          }
          openaiService.endConversation(callControlId);
        }, 2000);
      }
    }
  } catch (error) {
    console.error('Error processing transcription:', error);
    connection.ws.send(JSON.stringify({
      type: 'error',
      error: 'Failed to process transcription'
    }));
  }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(message) {
  if (!wss) return;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

/**
 * Send message to specific connection
 */
function sendToConnection(connectionId, message) {
  const connection = activeConnections.get(connectionId);
  if (connection && connection.ws.readyState === WebSocket.OPEN) {
    connection.ws.send(JSON.stringify(message));
  }
}

/**
 * Generate unique connection ID
 */
function generateConnectionId() {
  return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
  initializeWebSocketServer,
  broadcast,
  sendToConnection,
  activeConnections
};

