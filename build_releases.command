#!/bin/bash

# Get the directory where this script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "========================================="
echo "   Building Hephaestus Release Binaries  "
echo "========================================="
echo ""
echo "Cleaning old dist folder and building Vite project..."
npm run build

echo ""
echo "Building macOS, Windows, and Linux binaries..."
# The -mwl flag tells electron-builder to build for Mac, Windows, and Linux
npx electron-builder -mwl

echo ""
echo "========================================="
echo "   Build Complete!                       "
echo "========================================="
echo "Your new binaries (.exe, .dmg, .AppImage) are ready in the 'dist' folder."
echo ""

# Keep terminal open so the user can see the result
read -p "Press any key to close..."
