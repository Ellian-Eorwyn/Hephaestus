#!/bin/bash

REPO_URL="https://github.com/Ellian-Eorwyn/Hephaestus.git"
INSTALL_DIR="${HOME}/.hephaestus"
BIN_DIR="${HOME}/.local/bin"
EXECUTABLE_NAME="hephaestus"

command=$1

install_app() {
    echo "Installing Hephaestus..."
    
    if [ -d "$INSTALL_DIR" ]; then
        echo "Error: Directory $INSTALL_DIR already exists."
        echo "If you want to update, run this script with the 'update' argument."
        exit 1
    fi
    
    # Check dependencies
    if ! command -v git &> /dev/null; then
        echo "Error: git is required but not installed."
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        echo "Error: npm is required but not installed."
        exit 1
    fi
    
    git clone "$REPO_URL" "$INSTALL_DIR"
    
    cd "$INSTALL_DIR" || exit
    echo "Installing Node dependencies..."
    npm install
    
    # Create wrapper script
    mkdir -p "$BIN_DIR"
    
    WRAPPER_SCRIPT="$BIN_DIR/$EXECUTABLE_NAME"
    cat <<EOF > "$WRAPPER_SCRIPT"
#!/bin/bash
cd "$INSTALL_DIR" && npm run launch
EOF
    chmod +x "$WRAPPER_SCRIPT"
    
    echo "Hephaestus installed successfully!"
    echo "You can run it by typing '$EXECUTABLE_NAME' in your terminal."
    
    # Check if BIN_DIR is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        echo ""
        echo "WARNING: $BIN_DIR is not in your PATH."
        echo "You may need to add it to your ~/.bashrc or ~/.zshrc file:"
        echo "export PATH=\"\$PATH:$BIN_DIR\""
    fi
}

update_app() {
    echo "Updating Hephaestus..."
    
    if [ ! -d "$INSTALL_DIR" ]; then
        echo "Error: Hephaestus is not installed in $INSTALL_DIR."
        exit 1
    fi
    
    cd "$INSTALL_DIR" || exit
    git pull
    echo "Updating Node dependencies..."
    npm install
    
    echo "Hephaestus updated successfully!"
}

uninstall_app() {
    echo "Uninstalling Hephaestus..."
    
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed directory: $INSTALL_DIR"
    else
        echo "Directory $INSTALL_DIR not found."
    fi
    
    WRAPPER_SCRIPT="$BIN_DIR/$EXECUTABLE_NAME"
    if [ -f "$WRAPPER_SCRIPT" ]; then
        rm "$WRAPPER_SCRIPT"
        echo "Removed executable: $WRAPPER_SCRIPT"
    fi
    
    echo "Hephaestus uninstalled successfully!"
}

case $command in
    install)
        install_app
        ;;
    update)
        update_app
        ;;
    uninstall)
        uninstall_app
        ;;
    *)
        echo "Usage: $0 {install|update|uninstall}"
        echo ""
        echo "Examples:"
        echo "  Local execution:"
        echo "    ./setup.sh install"
        echo "    ./setup.sh update"
        echo "    ./setup.sh uninstall"
        echo ""
        echo "  Remote execution (via GitHub):"
        echo "    curl -sSL https://raw.githubusercontent.com/Ellian-Eorwyn/Hephaestus/main/setup.sh | bash -s install"
        exit 1
esac
