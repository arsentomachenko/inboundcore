# Backend Scripts

This directory contains utility scripts for managing your Telnyx Voice AI application.

## Available Scripts

### clearAllData.sh

**Purpose:** Clears all cost tracking and conversation history from both PostgreSQL database and JSON files.

**Usage:**
```bash
cd backend
./scripts/clearAllData.sh
```

**What it clears:**
- PostgreSQL tables: `costs`, `conversations`, `transferred_calls`
- JSON files: `costs.json`, `conversations.json`, `transferred-calls.json`

**Note:** Requires sudo access for PostgreSQL operations.

### Alternative: API Endpoint

You can also clear data via the API endpoint:

```bash
curl -X DELETE http://localhost:3001/api/agent/clear-all-data
```

This endpoint requires the server to be running and will:
- Clear the PostgreSQL database tables
- Clear the in-memory cache
- Return a summary of deleted records

## When to Use

- **Testing:** Clear data between test runs
- **Privacy:** Remove sensitive conversation data
- **Maintenance:** Clean up old records to improve performance
- **Development:** Reset to a clean state

## Safety Notes

⚠️ **Warning:** These operations are irreversible! Make sure you have backups if needed.

- All cost tracking data will be permanently deleted
- All conversation history will be permanently deleted  
- All transferred call records will be permanently deleted
- Users table is NOT affected (contacts remain intact)

## Backup Before Clearing

If you want to backup data before clearing:

```bash
# Backup PostgreSQL
sudo -u postgres pg_dump telnyx_voice_ai > backup_$(date +%Y%m%d).sql

# Backup JSON files
cp data/costs.json data/costs_backup_$(date +%Y%m%d).json
cp data/conversations.json data/conversations_backup_$(date +%Y%m%d).json
```

