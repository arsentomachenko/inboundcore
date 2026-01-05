#!/bin/bash

# Database Setup Script for Telnyx Voice AI
# This script helps you set up PostgreSQL for the application

set -e

echo "🗄️  PostgreSQL Database Setup for Telnyx Voice AI"
echo "=================================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo -e "${YELLOW}PostgreSQL is not installed.${NC}"
    echo ""
    read -p "Do you want to install PostgreSQL? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Installing PostgreSQL..."
        
        # Detect OS
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            sudo apt update
            sudo apt install -y postgresql postgresql-contrib
            sudo systemctl start postgresql
            sudo systemctl enable postgresql
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            brew install postgresql
            brew services start postgresql
        else
            echo -e "${RED}Unsupported OS. Please install PostgreSQL manually.${NC}"
            exit 1
        fi
        
        echo -e "${GREEN}✅ PostgreSQL installed successfully${NC}"
    else
        echo -e "${RED}PostgreSQL is required. Exiting.${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✅ PostgreSQL is installed${NC}"
echo ""

# Get database configuration
echo "Please provide database configuration:"
echo ""

read -p "Database name [telnyx_voice_ai]: " DB_NAME
DB_NAME=${DB_NAME:-telnyx_voice_ai}

read -p "Database user [telnyx_user]: " DB_USER
DB_USER=${DB_USER:-telnyx_user}

read -sp "Database password [random will be generated]: " DB_PASSWORD
echo ""
if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD=$(openssl rand -base64 12)
    echo -e "${YELLOW}Generated password: ${DB_PASSWORD}${NC}"
fi

read -p "Database host [localhost]: " DB_HOST
DB_HOST=${DB_HOST:-localhost}

read -p "Database port [5432]: " DB_PORT
DB_PORT=${DB_PORT:-5432}

echo ""
echo "Creating database..."

# Create database and user
sudo -u postgres psql <<EOF
-- Create user if not exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;

-- Create database if not exists
SELECT 'CREATE DATABASE $DB_NAME'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;

-- Connect to database and grant schema privileges
\c $DB_NAME
GRANT ALL PRIVILEGES ON SCHEMA public TO $DB_USER;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $DB_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
EOF

echo -e "${GREEN}✅ Database created successfully${NC}"
echo ""

# Update .env file
ENV_FILE="../.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Creating .env file from env.sample..."
    cp ../env.sample "$ENV_FILE"
fi

# Check if database config already exists
if grep -q "DB_HOST=" "$ENV_FILE"; then
    echo "Updating existing database configuration in .env..."
    sed -i "s/DB_HOST=.*/DB_HOST=$DB_HOST/" "$ENV_FILE"
    sed -i "s/DB_PORT=.*/DB_PORT=$DB_PORT/" "$ENV_FILE"
    sed -i "s/DB_NAME=.*/DB_NAME=$DB_NAME/" "$ENV_FILE"
    sed -i "s/DB_USER=.*/DB_USER=$DB_USER/" "$ENV_FILE"
    sed -i "s/DB_PASSWORD=.*/DB_PASSWORD=$DB_PASSWORD/" "$ENV_FILE"
else
    echo "Adding database configuration to .env..."
    cat >> "$ENV_FILE" <<EOL

# Database Configuration (PostgreSQL)
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
LOG_QUERIES=false
EOL
fi

echo -e "${GREEN}✅ .env file updated${NC}"
echo ""

# Test connection
echo "Testing database connection..."
if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "SELECT 1;" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Database connection successful!${NC}"
else
    echo -e "${RED}❌ Database connection failed${NC}"
    exit 1
fi

echo ""
echo "=================================================="
echo -e "${GREEN}✅ Database setup completed!${NC}"
echo "=================================================="
echo ""
echo "Database Configuration:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo "  Password: $DB_PASSWORD"
echo ""
echo "Next steps:"
echo "  1. Run the migration script to transfer data from JSON:"
echo "     node scripts/migrateToDatabase.js"
echo ""
echo "  2. Start your application:"
echo "     npm start"
echo ""

