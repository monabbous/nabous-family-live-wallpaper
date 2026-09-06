# If not built then error out

if [ ! -d "build/Wallserve.app" ]; then
  echo "Error: Wallserve.app not found. Please build the project first."
  exit 1
fi

rm -rf \
  ~/Applications/Wallserve.app

cp -R \
  build/Wallserve.app \
  ~/Applications/


rm -f ~/Library/LaunchAgents/com.example.wallserve.plist

cp \
  background-server.template.plist \
  ~/Library/LaunchAgents/com.example.wallserve.plist

USERNAME=$(whoami)
REPO_DIR=$(cd "$(dirname "$0")" && pwd)
PORT=8765

# replace placeholders in the plist file with actual values
sed -i '' "s|<USERNAME>|$USERNAME|g" ~/Library/LaunchAgents/com.example.wallserve.plist
sed -i '' "s|<REPO_DIR>|$REPO_DIR|g" ~/Library/LaunchAgents/com.example.wallserve.plist
sed -i '' "s|<PORT>|$PORT|g" ~/Library/LaunchAgents/com.example.wallserve.plist

launchctl unload ~/Library/LaunchAgents/com.example.wallserve.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.example.wallserve.plist

launchctl kickstart -k gui/$(id -u)/com.example.wallserve
