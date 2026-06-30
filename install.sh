#!/bin/bash
set -e

REPO="Ellian-Eorwyn/Hephaestus"
API_URL="https://api.github.com/repos/$REPO/releases/latest"

echo "Fetching latest release from $REPO..."
# We use curl and grep to safely parse the JSON response without needing jq
LATEST_RELEASE=$(curl -s $API_URL)
VERSION=$(echo "$LATEST_RELEASE" | grep -o '"tag_name": *"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')

if [ -z "$VERSION" ]; then
    echo "Error: Could not determine latest release version."
    exit 1
fi

echo "Latest version is $VERSION"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
    Linux*)     
        # Download AppImage
        DOWNLOAD_URL=$(echo "$LATEST_RELEASE" | grep -o '"browser_download_url": *"[^"]*\.AppImage"' | grep -o '"[^"]*"$' | tr -d '"')
        if [ -z "$DOWNLOAD_URL" ]; then
            echo "Error: Could not find AppImage in the latest release."
            exit 1
        fi
        echo "Downloading $DOWNLOAD_URL..."
        APPIMAGE_PATH="/tmp/Hephaestus.AppImage"
        curl -L -o "$APPIMAGE_PATH" "$DOWNLOAD_URL"
        chmod +x "$APPIMAGE_PATH"
        
        DEST_DIR="$HOME/.local/bin"
        mkdir -p "$DEST_DIR"
        mv "$APPIMAGE_PATH" "$DEST_DIR/Hephaestus"
        
        # Create Desktop entry
        DESKTOP_FILE="$HOME/.local/share/applications/hephaestus.desktop"
        mkdir -p "$HOME/.local/share/applications"
        cat > "$DESKTOP_FILE" <<EOL
[Desktop Entry]
Name=Hephaestus
Exec=$DEST_DIR/Hephaestus
Type=Application
Categories=Development;
EOL
        echo "Installation complete. You can run 'Hephaestus' from your terminal or application launcher."
        ;;
    Darwin*)    
        # Download DMG
        DOWNLOAD_URL=$(echo "$LATEST_RELEASE" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | grep -o '"[^"]*"$' | tr -d '"')
        if [ -z "$DOWNLOAD_URL" ]; then
            echo "Error: Could not find DMG in the latest release."
            exit 1
        fi
        echo "Downloading $DOWNLOAD_URL..."
        DMG_PATH="/tmp/Hephaestus.dmg"
        curl -L -o "$DMG_PATH" "$DOWNLOAD_URL"
        
        echo "Mounting DMG..."
        hdiutil attach "$DMG_PATH" -nobrowse -mountpoint /Volumes/Hephaestus_Installer
        
        echo "Installing to /Applications..."
        cp -R "/Volumes/Hephaestus_Installer/Hephaestus.app" /Applications/ || true
        
        echo "Unmounting DMG..."
        hdiutil detach /Volumes/Hephaestus_Installer
        rm "$DMG_PATH"
        
        echo "Installation complete. Hephaestus is now in your Applications folder."
        ;;
    *)
        echo "Unsupported operating system: ${OS}"
        echo "Please use install.ps1 for Windows."
        exit 1
        ;;
esac
