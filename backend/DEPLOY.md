# Deploy the term-premium function

Prereqs:
- Firebase project on the **Blaze** plan (functions won't deploy on Spark; ~$0 at this volume).
- A free FRED API key: https://fred.stlouisfed.org/docs/api/api_key.html
- Firebase CLI installed; you're already logged in.

From this `backend/` folder, in PowerShell:

```powershell
firebase use                                 # should show portfolio-dashboard-28672
cd functions; npm install; cd ..
firebase functions:secrets:set FRED_KEY      # paste your FRED key when prompted
firebase deploy --only functions
```

After deploy, open the printed `updateRatesNow` URL once to backfill `portfolio/rates`.
It then runs automatically every weekday 6pm Central.

Change cadence: edit the `schedule` cron in functions/index.js and redeploy.
