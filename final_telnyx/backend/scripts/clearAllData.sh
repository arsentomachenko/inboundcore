#!/bin/bash
# Clear All Cost & Conversation History
# This script clears data from both PostgreSQL database and JSON files

echo "🗑️  Starting data cleanup..."
echo ""

# 1. Clear JSON files
echo "📋 Clearing JSON files..."
cd "$(dirname "$0")/../data"

echo '[]' > costs.json
echo '[]' > conversations.json
echo '[]' > transferred-calls.json

echo "✅ Cleared costs.json"
echo "✅ Cleared conversations.json"
echo "✅ Cleared transferred-calls.json"
echo ""

# 2. Clear PostgreSQL database
echo "💾 Clearing PostgreSQL database..."
sudo -u postgres psql -d telnyx_voice_ai <<EOF
DELETE FROM costs;
DELETE FROM conversations;
DELETE FROM transferred_calls;
SELECT 
  'costs' as table_name, COUNT(*) as remaining FROM costs
UNION
SELECT 'conversations', COUNT(*) FROM conversations
UNION
SELECT 'transferred_calls', COUNT(*) FROM transferred_calls;
EOF

echo ""
echo "🎉 All cost and conversation history cleared successfully!"
echo ""
echo "📊 Summary:"
echo "   ✅ JSON files cleared (costs, conversations, transferred-calls)"
echo "   ✅ PostgreSQL database cleared (costs, conversations, transferred_calls)"
echo ""
echo "Note: If you have a running server, the in-memory cache will be cleared"
echo "      on the next restart, or you can use the API endpoint:"
echo "      curl -X DELETE http://localhost:3001/api/agent/clear-all-data"

