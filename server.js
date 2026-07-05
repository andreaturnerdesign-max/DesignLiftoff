{
  "name": "design-liftoff-backend",
  "version": "1.0.0",
  "description": "Server that verifies Google Sign-In server-side and gates access to the Design Liftoff checklist app.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "cookie-parser": "^1.4.6",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "google-auth-library": "^9.11.0",
    "jsonwebtoken": "^9.0.2"
  }
}
