#!/usr/bin/env bash
set -e

REPO="hefy2027/cf-manager"
RAW_URL="https://raw.githubusercontent.com/${REPO}/master/reg"
INSTALL_DIR="${CF_REG_INSTALL_DIR:-$PWD}"
MIN_NODE_VERSION=20

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Cloudflare Batch Registration Tool - Installer"
echo "=================================================="
echo ""

# -- Check Node.js --
echo "[1/4] Checking Node.js..."

if ! command -v node &> /dev/null; then
    echo "[ERR] Node.js not found. Please install Node.js >= ${MIN_NODE_VERSION}"
    echo "      Visit: https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -e "console.log(process.version.split('.')[0].replace('v',''))")
if [ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]; then
    echo "[ERR] Node.js v${NODE_VERSION} is too old. Requires >= v${MIN_NODE_VERSION}"
    echo "      Visit: https://nodejs.org"
    exit 1
fi

echo "[OK] Node.js v$(node -v) detected"

# -- Check npm --
echo "[2/4] Checking npm..."
if ! command -v npm &> /dev/null; then
    echo "[ERR] npm not found. Please reinstall Node.js (npm is included)"
    exit 1
fi
echo "[OK] npm v$(npm -v) detected"

# -- Download / verify files --
echo "[3/4] Preparing files..."

mkdir -p "$INSTALL_DIR"

if [ ! -f "${INSTALL_DIR}/cf-reg.mjs" ]; then
    echo "      Downloading cf-reg.mjs..."
    curl -fsSL "${RAW_URL}/cf-reg.mjs" -o "${INSTALL_DIR}/cf-reg.mjs"
else
    echo "      cf-reg.mjs already exists, skip download"
fi

if [ ! -f "${INSTALL_DIR}/config.json" ]; then
    echo "      Downloading config.json..."
    curl -fsSL "${RAW_URL}/config.example.json" -o "${INSTALL_DIR}/config.json"
else
    echo "      config.json already exists, skip download"
fi

# Create cf-reg wrapper
cat > "${INSTALL_DIR}/cf-reg" << EOF
#!/usr/bin/env bash
node "${INSTALL_DIR}/cf-reg.mjs" "\$@"
EOF
chmod +x "${INSTALL_DIR}/cf-reg"

echo "[OK] Files ready in ${INSTALL_DIR}"

# -- Check and install Windows fonts (Linux only) --
install_windows_fonts() {
    # Only for Linux
    if [[ "$OSTYPE" != "linux-gnu"* ]]; then
        return 0
    fi

    echo "[3.5/4] Checking Windows fonts for cloakbrowser..."

    # Check if common Windows fonts exist
    local font_check=false
    if fc-list | grep -qi "arial\|times\|courier\|verdana\|trebuchet"; then
        font_check=true
    fi

    if [ "$font_check" = true ]; then
        echo "[OK] Windows fonts already installed"
        return 0
    fi

    echo "[WARN] Windows fonts not found - cloakbrowser works better with them"
    echo "        See: https://github.com/CloakHQ/cloakbrowser#font-setup-on-linux"
    echo ""

    # Detect package manager and offer to install
    if command -v apt-get &> /dev/null; then
        echo "        Detected: Debian/Ubuntu"
        echo "        Run: sudo apt-get install -y ttf-mscorefonts-installer"
        echo ""
    elif command -v yum &> /dev/null; then
        echo "        Detected: CentOS/RHEL"
        echo "        Run: sudo yum install -y curl cabextract xorg-x11-font-utils fontconfig"
        echo "        Then: sudo rpm -i https://downloads.sourceforge.net/project/mscorefonts2/rpms/msttcore-fonts-installer-2.6-1.noarch.rpm"
        echo ""
    elif command -v dnf &> /dev/null; then
        echo "        Detected: Fedora"
        echo "        Run: sudo dnf install -y curl cabextract xorg-x11-font-utils fontconfig"
        echo "        Then: sudo rpm -i https://downloads.sourceforge.net/project/mscorefonts2/rpms/msttcore-fonts-installer-2.6-1.noarch.rpm"
        echo ""
    elif command -v pacman &> /dev/null; then
        echo "        Detected: Arch Linux"
        echo "        Run: yay -S ttf-ms-fonts"
        echo "        Or: sudo pacman -S ttf-ms-fonts (from AUR)"
        echo ""
    fi

    echo "        Or set CLOAKBROWSER_SUPPRESS_FONT_WARNING=1 to suppress this warning"
    echo ""
    read -p "        Attempt to install fonts now? (requires sudo) [y/N] " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if command -v apt-get &> /dev/null; then
            sudo apt-get update && sudo apt-get install -y ttf-mscorefonts-installer
        elif command -v yum &> /dev/null; then
            sudo yum install -y curl cabextract xorg-x11-font-utils fontconfig
            sudo rpm -i https://downloads.sourceforge.net/project/mscorefonts2/rpms/msttcore-fonts-installer-2.6-1.noarch.rpm || true
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y curl cabextract xorg-x11-font-utils fontconfig
            sudo rpm -i https://downloads.sourceforge.net/project/mscorefonts2/rpms/msttcore-fonts-installer-2.6-1.noarch.rpm || true
        elif command -v pacman &> /dev/null; then
            echo "[WARN] Arch Linux requires manual installation from AUR"
            echo "       Run: yay -S ttf-ms-fonts"
        fi
        echo "[OK] Font installation attempted"
    else
        echo "[INFO] Skipping font installation"
        echo "[INFO] Set CLOAKBROWSER_SUPPRESS_FONT_WARNING=1 to suppress warning"
    fi
    echo ""
}

install_windows_fonts

# -- Install dependencies --
echo "[4/4] Installing dependencies..."

cd "$INSTALL_DIR"
cat > package.json << EOF
{
  "name": "cf-reg-local",
  "version": "1.0.0",
  "type": "module"
}
EOF

npm install --no-save cloakbrowser commander node-fetch playwright-core &> /dev/null || {
    echo "[WARN] Failed to install some dependencies. You may need to run manually:"
    echo "       cd ${INSTALL_DIR} && npm install cloakbrowser commander node-fetch playwright-core"
}

echo "[OK] Dependencies installed"

# -- Pre-download Stealth Chromium for cloakbrowser --
echo "[INFO] Pre-downloading Stealth Chromium (this may take a while)..."

# Ensure .download-chromium.mjs is present
if [ ! -f "${INSTALL_DIR}/.download-chromium.mjs" ]; then
    curl -fsSL "${RAW_URL}/.download-chromium.mjs" -o "${INSTALL_DIR}/.download-chromium.mjs"
fi

# Run the download script
node "${INSTALL_DIR}/.download-chromium.mjs" 2>&1 | while IFS= read -r line; do
    echo "        $line"
done

echo "[OK] Chromium pre-download step completed"

echo ""
echo "=================================================="
echo "  Installation complete!"
echo "=================================================="
echo ""
echo "Usage:"
echo "  ./cf-reg --help"
echo "  ./cf-reg --count 5"
echo ""
echo "Or add to PATH for global access:"
echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
echo ""
echo "Config:"
echo "  Edit ${INSTALL_DIR}/config.json to customize settings"
echo ""
echo "CF Manager: https://github.com/${REPO}"
echo ""
