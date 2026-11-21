# Bipin Bhai On Top — History & Statistics

Honest history and statistics app for WinGo results.

- Records past results (period + number 0-9) in PostgreSQL via the backend.
- Shows historical statistics only: Big/Small counts, number frequency 0-9, recent history.
- **Information only — this is NOT a prediction tool.** Random game outcomes cannot be predicted. No guaranteed wins. No forced/prediction override exists in this app.

## Deploy (Render Blueprint)
1. Push the contents of this folder to the root of a GitHub repository.
2. In Render: New + -> Blueprint, connect the repo, Apply. It creates the web service + PostgreSQL database.
3. Open the service URL and check `/api/health`.
