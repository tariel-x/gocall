#!/bin/bash

# Build script for familycall server
# Compiles Go backend into a single binary

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Building familycall server...${NC}"

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Copy web files if they don't exist in server/web
if [ ! -d "web" ]; then
    echo -e "${BLUE}Copying web files...${NC}"
    if [ -d "../src" ]; then
        cp -r ../src web
    else
        echo "Warning: ../src directory not found"
    fi
fi

# Build for current platform
echo -e "${BLUE}Building for $(go env GOOS)/$(go env GOARCH)...${NC}"
go build -o familycall-server .

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Build successful!${NC}"
    echo -e "${GREEN}Binary: $SCRIPT_DIR/familycall-server${NC}"
    
    # Show binary size
    if command -v ls &> /dev/null; then
        SIZE=$(ls -lh familycall-server | awk '{print $5}')
        echo -e "${BLUE}Binary size: $SIZE${NC}"
    fi
else
    echo "Build failed!"
    exit 1
fi

