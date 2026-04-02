#!/usr/bin/env bash
set -euo pipefail

EXPECTED_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Setting up pi-config at $EXPECTED_DIR"
echo ""

# Create settings.json if it doesn't exist
if [ ! -f "$EXPECTED_DIR/settings.json" ]; then
  echo "Creating settings.json..."
  cat > "$EXPECTED_DIR/settings.json" << 'EOF'
{
  "defaultThinkingLevel": "high",
  "defaultProvider": "azure-openai-responses",
  "defaultModel": "gpt-5.4",
  "packages": [
    "git:github.com/nicobailon/pi-mcp-adapter",
    "git:github.com/nicobailon/pi-powerline-footer",
    "git:github.com/HazAT/pi-smart-sessions",
    "git:github.com/omaclaren/pi-markdown-preview",
    "git:github.com/aliou/pi-guardrails",
    "git:github.com/arosstale/pi-notify",
    "git:github.com/pasky/chrome-cdp-skill"
  ],
  "hideThinkingBlock": false
}
EOF
else
  echo "settings.json already exists — skipping creation"
  echo "Make sure your packages list includes:"
  echo '  "git:github.com/nicobailon/pi-mcp-adapter"'
  echo '  "git:github.com/nicobailon/pi-powerline-footer"'
  echo '  "git:github.com/HazAT/pi-smart-sessions"'
  echo '  "git:github.com/omaclaren/pi-markdown-preview"'
  echo '  "git:github.com/aliou/pi-guardrails"'
  echo '  "git:github.com/arosstale/pi-notify"'
  echo '  "git:github.com/pasky/chrome-cdp-skill"'
  echo ""
fi

# Install git packages
echo "Installing packages..."
pi install git:github.com/nicobailon/pi-mcp-adapter
pi install git:github.com/nicobailon/pi-powerline-footer
pi install git:github.com/HazAT/pi-smart-sessions
pi install git:github.com/omaclaren/pi-markdown-preview
pi install git:github.com/aliou/pi-guardrails
pi install git:github.com/arosstale/pi-notify
pi install git:github.com/pasky/chrome-cdp-skill
echo ""

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."