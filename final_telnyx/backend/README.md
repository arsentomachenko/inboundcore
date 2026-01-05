# Voice AI Agent - Backend

Express.js backend for Voice AI Agent with Telnyx Voice API and OpenAI integration.

## Features

- 🎯 Outbound calling with Telnyx Voice API
- 🤖 OpenAI-powered conversational AI agent
- 🔊 Real-time Speech-to-Text (STT) via Telnyx
- 🗣️ ElevenLabs Text-to-Speech (TTS) via Telnyx
- ⚡ WebSocket for low-latency communication
- 📞 DID rotation for multiple phone numbers
- 📊 User management with CSV import
- 🎮 Agent control (start/stop/pause/resume)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.sample` to `.env` and fill in your credentials:
```bash
cp .env.sample .env
```

3. Configure your Telnyx application:
   - Create a Voice API application in Telnyx Dashboard
   - Set webhook URL to: `https://your-domain.com/webhooks/telnyx`
   - Enable Call Control and Transcription
   - Purchase phone numbers and assign to your application

4. Configure OpenAI:
   - Add your OpenAI API key to `.env`

5. Configure ElevenLabs TTS:
   - Add your ElevenLabs API key to `.env`
   - The API key will be automatically registered with Telnyx on startup
   - Optionally configure a voice ID (defaults to Adam voice)

6. Start the server:
```bash
npm run dev
```

## API Endpoints

### Users
- `GET /api/users` - Get all users
- `GET /api/users/:id` - Get user by ID
- `POST /api/users` - Create new user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `POST /api/users/import` - Import users from CSV

### Calls
- `POST /api/calls/initiate` - Initiate outbound call
- `POST /api/calls/hangup` - Hangup active call
- `GET /api/calls/active` - Get all active calls
- `GET /api/calls/:callControlId/status` - Get call status

### DID Management
- `GET /api/did/available` - Get available phone numbers
- `GET /api/did/purchased` - Get purchased phone numbers
- `POST /api/did/purchase` - Purchase a phone number
- `GET /api/did/rotation` - Get DID rotation settings
- `POST /api/did/rotation/configure` - Configure DID rotation
- `POST /api/did/rotation/toggle` - Enable/disable DID rotation
- `GET /api/did/rotation/next` - Get next number in rotation

### Agent Control
- `GET /api/agent/status` - Get agent status
- `POST /api/agent/start` - Start AI agent calling
- `POST /api/agent/stop` - Stop AI agent
- `POST /api/agent/pause` - Pause AI agent
- `POST /api/agent/resume` - Resume AI agent
- `GET /api/agent/stats` - Get agent statistics

### Webhooks
- `POST /webhooks/telnyx` - Telnyx webhook endpoint
- `GET /webhooks/health` - Health check

## WebSocket

Connect to `ws://your-domain:3000/ws` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data);
};
```

## CSV Format for User Import

```csv
firstname,lastname,phone,address,email,notes
John,Doe,+15551234567,"123 Main St, City, ST 12345",john@example.com,Interested in coverage
Jane,Smith,+15559876543,"456 Oak Ave, Town, ST 54321",jane@example.com,Follow-up needed
```

## Environment Variables

See `.env.sample` for all required environment variables.

## Architecture

```
┌─────────────┐     WebSocket    ┌──────────────┐
│   Frontend  │◄────────────────►│   Backend    │
└─────────────┘                  └──────┬───────┘
                                        │
                         ┌──────────────┼──────────────┐
                         │              │              │
                    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
                    │ Telnyx  │   │ OpenAI  │   │  Users  │
                    │   API   │   │   API   │   │   DB    │
                    └─────────┘   └─────────┘   └─────────┘
```

## Call Flow

1. Backend initiates call via Telnyx API
2. User answers → Telnyx sends webhook
3. Backend starts transcription (STT)
4. User speaks → Telnyx transcribes → sends to backend
5. Backend sends transcript to OpenAI
6. OpenAI returns response
7. Backend uses ElevenLabs TTS via Telnyx to speak response
8. Process repeats until call completes

## License

MIT

