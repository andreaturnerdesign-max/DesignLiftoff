# Copy this file to ".env" and fill in real values. Never commit ".env".

# From https://console.cloud.google.com/apis/credentials
# (OAuth client ID, Web application type)
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com

# Comma-separated list of Google account emails allowed to sign in.
ALLOWED_EMAILS=you@example.com,colleague@example.com

# Long random string used to sign session cookies. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
SESSION_SECRET=replace-this-with-a-long-random-string

# Port the server listens on (most hosts set this for you automatically).
PORT=3000

# Optional: where to store user checklist data. Defaults to ./data next to
# the server code. Set this to a mounted persistent volume's path on hosts
# where the regular filesystem doesn't survive redeploys.
# DATA_DIR=/data

# --- Optional: grant access automatically via Shopify purchases ---
# Leave both blank to disable this feature (ALLOWED_EMAILS above still works
# on its own). See README.md for how to set up the Shopify side.

# The webhook signing secret from your Shopify custom app / webhook config.
# SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Comma-separated Shopify product IDs (numeric, not the handle/slug) that
# grant access when purchased. Leave blank to grant access on ANY paid
# order from your store, regardless of what was bought.
# SHOPIFY_PRODUCT_IDS=1234567890,9876543210
