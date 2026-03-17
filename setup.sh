#!/usr/bin/env bash
set -euo pipefail

EXPECTED_DIR="$HOME/.pi/agent"

echo "⚠️  This repo should be cloned to ~/.pi/agent/"
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
    "git:github.com/nicobailon/pi-subagents",
    "git:github.com/nicobailon/pi-mcp-adapter",
    "git:github.com/HazAT/pi-smart-sessions"
  ],
  "hideThinkingBlock": false
}
EOF
else
  echo "settings.json already exists — skipping creation"
  echo "Make sure your packages list includes:"
  echo '  "git:github.com/nicobailon/pi-subagents"'
  echo '  "git:github.com/nicobailon/pi-mcp-adapter"'
  echo '  "git:github.com/HazAT/pi-smart-sessions"'
  echo ""
fi

# Install git packages
echo "Installing packages..."
pi install git:github.com/nicobailon/pi-subagents 2>/dev/null || echo "  pi-subagents already installed"
pi install git:github.com/nicobailon/pi-mcp-adapter 2>/dev/null || echo "  pi-mcp-adapter already installed"
pi install git:github.com/nicobailon/pi-powerline-footer 2>/dev/null || echo "  pi-powerline-footer already installed"
pi install git:github.com/HazAT/pi-smart-sessions 2>/dev/null || echo "  pi-smart-sessions already installed"
pi install git:github.com/omaclaren/pi-markdown-preview 2>/dev/null || echo "  pi-markdown-preview already installed"
pi install git:github.com/aliou/pi-guardrails 2>/dev/null || echo "  pi-guardrails already installed"
pi install git:github.com/arosstale/pi-notify 2>/dev/null || echo "  pi-notify already installed"
echo ""

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."