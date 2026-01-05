#!/bin/bash

# Voice AI Agent - Quick Installation Script
# This script will set up both backend and frontend

set -e

echo "🚀 Voice AI Agent - Installation Script"
echo "========================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo ""

# Backend Setup
echo "📦 Setting up Backend..."
cd backend

if [ ! -f ".env" ]; then
    echo "📝 Creating backend .env file..."
    cp env.sample .env
    echo "⚠️  Please edit backend/.env with your credentials before starting the server"
else
    echo "✅ Backend .env file already exists"
fi

echo "📦 Installing backend dependencies..."
npm install

echo "✅ Backend setup complete!"
echo ""

# Frontend Setup
cd ../frontend
echo "📦 Setting up Frontend..."

if [ ! -f ".env" ]; then
    echo "📝 Creating frontend .env file..."
    cp env.sample .env
    echo "✅ Frontend .env file created"
else
    echo "✅ Frontend .env file already exists"
fi

echo "📦 Installing frontend dependencies..."
npm install

echo "✅ Frontend setup complete!"
echo ""

# Create data directory for backend
cd ../backend
mkdir -p data
echo "✅ Created data directory"

# Create uploads directory for CSV uploads
mkdir -p uploads
echo "✅ Created uploads directory"

echo ""
echo "🎉 Installation Complete!"
echo "========================"
echo ""
echo "📋 Next Steps:"
echo ""
echo "1. Configure Backend:"
echo "   - Edit backend/.env with your Telnyx and OpenAI credentials"
echo "   - See SETUP_GUIDE.md for detailed instructions"
echo ""
echo "2. Start Backend:"
echo "   cd backend"
echo "   npm run dev"
echo ""
echo "3. Start Frontend (in a new terminal):"
echo "   cd frontend"
echo "   npm start"
echo ""
echo "4. Open browser:"
echo "   http://localhost:5000"
echo ""
echo "📖 For detailed setup instructions, see SETUP_GUIDE.md"
echo "📄 Sample CSV file available: sample.csv"
echo ""

