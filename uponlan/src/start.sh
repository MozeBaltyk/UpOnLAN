#!/bin/bash

# Perform the initial configuration
/init.sh

echo "  _   _  ___   ___   _  _  _     ___  _  _   __  ____   _______  "
echo " | | | || _ \ / _ \ | \| || |   /   \| \| |  \ \/ /\ \ / /|_  /  "
echo " | |_| ||  _/| (_) || .  || |__ | - || .  |   >  <  \   /  / /   "
echo "  \___/ |_|   \___/ |_|\_||____||_|_||_|\_|()/_/\_\  |_|  /___|  "
echo ""
echo " Starting PXE Boot Service "
echo ""
supervisord -c /etc/supervisor.conf
