# Voice AI Agent - Frontend

React-based frontend dashboard for managing Voice AI Agent operations.

## Features

- 📊 Real-time dashboard with statistics
- 🎮 Agent control panel (start/stop/pause/resume)
- 👥 User management with CSV import
- 📞 DID management and rotation
- 🔴 Live call monitoring
- ⚡ WebSocket for real-time updates

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `env.sample` to `.env`:
```bash
cp env.sample .env
```

3. Update `.env` with your backend URL:
```
REACT_APP_API_URL=http://localhost:3000/api
REACT_APP_BACKEND_HOST=localhost:3000
PORT=5000
```

4. Start development server:
```bash
npm start
```

The app will open at `http://localhost:5000`

## Build for Production

```bash
npm run build
```

This creates an optimized build in the `build/` directory.

## Dashboard Sections

### 1. Dashboard
- Overview of all statistics
- Call success rates
- Qualification rates
- Visual charts

### 2. Agent Control
- Start/stop/pause/resume AI agent
- Select specific users or call all pending
- Configure delay between calls
- Real-time progress monitoring

### 3. User Management
- Add, edit, delete users
- Import users from CSV
- View call history and status
- One-click calling

### 4. DID Management
- View purchased phone numbers
- Search and purchase new numbers
- Configure DID rotation
- Enable/disable rotation

### 5. Call Monitor
- View active calls in real-time
- See live transcriptions
- Monitor conversation stages
- View call event logs

## CSV Import Format

When importing users, use this CSV format:

```csv
firstname,lastname,phone,address,state
John,Doe,+15551234567,"123 Main St, City",KY
Jane,Smith,+15559876543,"456 Oak Ave, Town",IL
```

Optional fields: `email`, `notes` can be added as additional columns.

## Technologies Used

- React 18
- Material-UI (MUI)
- Axios for API calls
- WebSocket for real-time updates
- Recharts for data visualization
- React Dropzone for file uploads

## API Integration

All API calls are handled through the `/src/services/api.js` service, which provides:

- `usersAPI` - User management
- `callsAPI` - Call operations
- `didAPI` - DID management
- `agentAPI` - Agent control

## WebSocket Events

The frontend listens for these WebSocket events:

- `call_event` - Call state changes (initiated, answered, hangup)
- `ai_response` - AI agent responses
- `transcription` - Live transcription updates

## License

MIT

